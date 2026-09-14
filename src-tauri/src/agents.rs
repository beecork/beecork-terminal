// Locating a running agent's CURRENT conversation, so a restored session can
// reopen the chat THAT tab was having (`claude --resume <id>`) rather than
// whichever conversation happened to run last.
//
// This is agent archaeology, not terminal plumbing: it knows how Claude Code and
// Codex name their transcript files and where they keep them. It lived inside
// `pty.rs` and had nothing to do with pseudo-terminals beyond being called from
// the same status poll — the pty module now just asks this one a question.
//
// Everything here is best-effort by design. `None` simply means the frontend
// falls back to the generic `--continue` / `codex resume`.
//
// For Claude the exact answer is Claude's own per-process registry
// (`claude_registry_uuid`). The older folder-based guess survives only for a
// Claude too old to write one: it gave every Claude tab in one folder the SAME id
// (whichever chat wrote last), so a relaunch resumed that one chat in all of them.

/// Claude Code names a project's transcript folder by its cwd with every non
/// -alphanumeric byte turned into `-` (no collapsing: `/Users/x/.foo` →
/// `-Users-x--foo`). Mirror that exactly so we can find the folder for a cwd.
fn claude_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// A 36-char `8-4-4-4-12` hex UUID? (validates the id we hand to `--resume`).
fn uuid_shaped(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, &c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// Pull the conversation UUID out of a transcript file *stem*. Claude's stem IS
/// the uuid; Codex's is `rollout-<iso-ts>-<uuid>` — either way the uuid is the
/// trailing 36 chars. `None` when the tail isn't uuid-shaped.
fn uuid_from_stem(stem: &str) -> Option<String> {
    stem.get(stem.len().checked_sub(36)?..)
        .filter(|tail| uuid_shaped(tail))
        .map(str::to_string)
}

/// Newest (by mtime) `*.jsonl` transcript in `dir`, as its conversation uuid.
/// This is the cheap "which chat is this folder's live one" signal.
fn newest_transcript_uuid(dir: &std::path::Path) -> Option<String> {
    let mut best: Option<(std::time::SystemTime, String)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(uuid) = path.file_stem().and_then(|s| s.to_str()).and_then(uuid_from_stem)
        else {
            continue;
        };
        let Ok(mtime) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if best.as_ref().is_none_or(|(t, _)| mtime > *t) {
            best = Some((mtime, uuid));
        }
    }
    best.map(|(_, uuid)| uuid)
}

/// Exact conversation id for a running Claude, from Claude Code's own registry:
/// every interactive `claude` writes `~/.claude/sessions/<pid>.json` holding the
/// `sessionId` it is running right now. Keyed by pid, so three tabs in one folder
/// get three different answers — which neither the folder scan nor `lsof` (Claude
/// closes its transcript between writes) can give. Older Claude versions write
/// no registry; `None` then and the caller falls back.
fn claude_registry_uuid(registry: &std::path::Path, pid: u32, proc_started: u64) -> Option<String> {
    let bytes = std::fs::read(registry.join(format!("{pid}.json"))).ok()?;
    registry_session_uuid(&bytes, pid, proc_started)
}

/// Parse one registry file. Pids are recycled and a Claude that crashed leaves
/// its file behind, so a file under a live pid may belong to an EARLIER process:
/// accept it only if it was written after this process started. `startedAt` is
/// milliseconds and `proc_started` whole seconds, both from the wall clock:
/// flooring is monotone, so a file written after the start never floors below
/// it. `proc_started == 0` means the OS gave no start time — accept.
fn registry_session_uuid(bytes: &[u8], pid: u32, proc_started: u64) -> Option<String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry {
        pid: u32,
        session_id: String,
        started_at: u64,
    }
    let e: Entry = serde_json::from_slice(bytes).ok()?;
    if e.pid != pid || e.started_at / 1000 < proc_started {
        return None;
    }
    uuid_shaped(&e.session_id).then_some(e.session_id)
}

/// Exact conversation id for a running agent by asking the OS which transcript
/// file the process currently holds open (`lsof`). Precise even with two agents
/// in one folder — but only when the agent is mid-write (Claude opens/closes its
/// transcript per append, so this frequently returns None and the caller falls
/// back). Unix-only; Windows has no lsof.
#[cfg(unix)]
fn lsof_transcript_uuid(pid: u32) -> Option<String> {
    let out = std::process::Command::new("lsof")
        .args(["-p", &pid.to_string(), "-Fn"])
        .output()
        .ok()?;
    // lsof exits non-zero when *some* fds can't be read; its stdout is still valid.
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Some(path) = line.strip_prefix('n') else { continue };
        let is_transcript = path.ends_with(".jsonl")
            && (path.contains("/.claude/projects/") || path.contains("/.codex/sessions/"));
        if !is_transcript {
            continue;
        }
        let stem = std::path::Path::new(path).file_stem().and_then(|s| s.to_str());
        if let Some(uuid) = stem.and_then(uuid_from_stem) {
            return Some(uuid);
        }
    }
    None
}

#[cfg(not(unix))]
fn lsof_transcript_uuid(_pid: u32) -> Option<String> {
    None
}

/// The conversation id to resume for a running agent, best-effort.
///
/// Claude: its own pid registry (exact); when two Claude tabs share a folder
/// (`disambiguate`), the exact open-file lookup next. Only a Claude too old to
/// write a registry at all gets the newest-transcript-in-folder guess. Codex: its
/// sessions aren't foldered by cwd, so there's no cheap fallback — we can only
/// pin the exact chat while codex still holds its rollout open. `None` → the
/// frontend keeps the generic `--continue` / `codex resume`.
///
/// `fg_cmd` is the foreground process group leader as (pid, start time in unix
/// seconds). For a `claude` typed at the prompt that leader IS the claude
/// process, which is the pid its registry file is named after.
pub fn resolve_agent_session(
    agent: &str,
    cwd: Option<&str>,
    fg_cmd: Option<(u32, u64)>,
    disambiguate: bool,
) -> Option<String> {
    match agent {
        "claude" => {
            let claude_home = crate::fs::home()?.join(".claude");
            resolve_claude_session(&claude_home, cwd, fg_cmd, disambiguate)
        }
        "codex" => fg_cmd.and_then(|(pid, _)| lsof_transcript_uuid(pid)),
        _ => None,
    }
}

/// The Claude arm of `resolve_agent_session`, with `~/.claude` passed in so the
/// order of the three sources is testable against a temp dir.
fn resolve_claude_session(
    claude_home: &std::path::Path,
    cwd: Option<&str>,
    fg_cmd: Option<(u32, u64)>,
    disambiguate: bool,
) -> Option<String> {
    let registry = claude_home.join("sessions");
    if let Some((pid, started)) = fg_cmd {
        if let Some(uuid) = claude_registry_uuid(&registry, pid, started) {
            return Some(uuid);
        }
    }
    if disambiguate {
        if let Some(uuid) = fg_cmd.and_then(|(pid, _)| lsof_transcript_uuid(pid)) {
            return Some(uuid);
        }
    }
    // This Claude registers itself but hasn't yet: it writes its file one to five
    // seconds after starting. Guessing now hands the tab whichever chat in the
    // folder wrote last — often ANOTHER tab's — and the UI stops its eager
    // lookups the moment every agent has an id, so the wrong one would stand
    // until the slow tick. "Not yet" keeps it asking. A tab that never registers
    // loses nothing: resume without an id is `claude --continue`, which is this
    // same guess made later.
    if registry.is_dir() {
        return None;
    }
    let project = claude_home.join("projects").join(claude_slug(cwd?));
    newest_transcript_uuid(&project)
}

#[cfg(test)]
mod tests {
    /// Create `path` with an mtime `secs_ago` in the past. Deterministic — no
    /// sleeping, so the ordering these tests assert cannot flake.
    fn touch(path: &std::path::Path, secs_ago: u64) {
        let f = std::fs::File::create(path).unwrap();
        f.set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(secs_ago))
            .unwrap();
    }

    // The fallback for a Claude too old to write `~/.claude/sessions/<pid>.json`:
    // `lsof` usually misses (Claude opens and closes its transcript per append),
    // so without the registry mtime-newest is all there is.
    #[test]
    fn newest_transcript_uuid_picks_the_most_recently_written_chat() {
        let dir = tempfile::tempdir().unwrap();
        // The NEWEST file sorts FIRST by name, so a pass cannot come from
        // read_dir order standing in for the mtime comparison.
        let newest = "11111111-1111-4111-8111-111111111111";
        let older = "99999999-9999-4999-8999-999999999999";
        touch(&dir.path().join(format!("{older}.jsonl")), 600);
        touch(&dir.path().join(format!("{newest}.jsonl")), 5);
        // Newest in the folder, but not resumable transcripts: a non-uuid stem
        // and a non-.jsonl file. Either would hand `--resume` a bogus id.
        touch(&dir.path().join("session-notes.jsonl"), 0);
        touch(&dir.path().join(format!("{newest}.json")), 0);
        assert_eq!(super::newest_transcript_uuid(dir.path()).as_deref(), Some(newest));
    }

    #[test]
    fn newest_transcript_uuid_handles_codex_stems_and_empty_folders() {
        let dir = tempfile::tempdir().unwrap();
        // Nothing resumable → None → the frontend keeps the generic `--continue`.
        assert_eq!(super::newest_transcript_uuid(dir.path()), None);
        let uuid = "019f5c24-8fb9-7362-8187-28ffcef7688c";
        touch(&dir.path().join(format!("rollout-2026-07-13T19-42-07-{uuid}.jsonl")), 5);
        assert_eq!(super::newest_transcript_uuid(dir.path()).as_deref(), Some(uuid));
    }

    /// A registry file in the shape Claude Code 2.1.270 writes (trimmed; the
    /// fields we don't read are kept so an unknown-field rejection would show).
    fn registry(pid: u32, session: &str, started_at_ms: u64) -> Vec<u8> {
        format!(
            r#"{{"pid":{pid},"sessionId":"{session}","cwd":"/Users/x/proj","startedAt":{started_at_ms},"version":"2.1.270","kind":"interactive","status":"idle","bridgeSessionId":null}}"#
        )
        .into_bytes()
    }

    // The fix for "every tab resumes the same chat": Claude tabs in ONE folder
    // must each get their own id. The folder scan can only ever return one.
    #[test]
    fn registry_gives_each_claude_process_its_own_session() {
        let a = "11111111-1111-4111-8111-111111111111";
        let b = "22222222-2222-4222-8222-222222222222";
        // Started at unix 1_789_000_000 s; registered 1.5 s later.
        let started = 1_789_000_000;
        assert_eq!(
            super::registry_session_uuid(&registry(100, a, 1_789_000_001_500), 100, started).as_deref(),
            Some(a)
        );
        assert_eq!(
            super::registry_session_uuid(&registry(200, b, 1_789_000_001_500), 200, started).as_deref(),
            Some(b)
        );
        // Registered within the same second the process started: the seconds
        // truncation must not reject it.
        assert_eq!(
            super::registry_session_uuid(&registry(100, a, 1_789_000_000_000), 100, started).as_deref(),
            Some(a)
        );
    }

    #[test]
    fn registry_rejects_a_file_left_by_an_earlier_owner_of_the_pid() {
        let a = "11111111-1111-4111-8111-111111111111";
        // Written an hour before the live process started: a crashed Claude's
        // leftover under a recycled pid, naming someone else's chat.
        let stale = registry(100, a, 1_788_996_400_000);
        assert_eq!(super::registry_session_uuid(&stale, 100, 1_789_000_000), None);
        // No start time from the OS → nothing to compare, accept.
        assert_eq!(super::registry_session_uuid(&stale, 100, 0).as_deref(), Some(a));
    }

    /// A fake `~/.claude` holding one project folder (`/x/proj`) whose newest
    /// transcript is `guess` — the answer the old folder scan gives every tab.
    fn claude_home_with_guess(guess: &str) -> tempfile::TempDir {
        let home = tempfile::tempdir().unwrap();
        let project = home.path().join("projects").join(super::claude_slug("/x/proj"));
        std::fs::create_dir_all(&project).unwrap();
        touch(&project.join(format!("{guess}.jsonl")), 5);
        home
    }

    // End to end through the resolver: the registry beats the folder guess, and
    // two processes in the same folder come back different.
    #[test]
    fn resolver_prefers_the_registry_over_the_folder_guess() {
        let guess = "99999999-9999-4999-8999-999999999999";
        let a = "11111111-1111-4111-8111-111111111111";
        let b = "22222222-2222-4222-8222-222222222222";
        let home = claude_home_with_guess(guess);
        let sessions = home.path().join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("100.json"), registry(100, a, 1_789_000_001_000)).unwrap();
        std::fs::write(sessions.join("200.json"), registry(200, b, 1_789_000_001_000)).unwrap();
        let resolve = |pid| {
            super::resolve_claude_session(home.path(), Some("/x/proj"), Some((pid, 1_789_000_000)), false)
        };
        assert_eq!(resolve(100).as_deref(), Some(a));
        assert_eq!(resolve(200).as_deref(), Some(b));
    }

    #[test]
    fn resolver_waits_for_a_registering_claude_instead_of_guessing() {
        let guess = "99999999-9999-4999-8999-999999999999";
        let home = claude_home_with_guess(guess);
        // Registry folder exists (this Claude writes one) but pid 300 hasn't yet.
        std::fs::create_dir_all(home.path().join("sessions")).unwrap();
        assert_eq!(
            super::resolve_claude_session(home.path(), Some("/x/proj"), Some((300, 1_789_000_000)), false),
            None
        );
        // Positive control: the SAME home without a registry folder — a Claude
        // too old to write one — still gets the guess, so the None above comes
        // from the registry rule and not from a broken project path.
        std::fs::remove_dir(home.path().join("sessions")).unwrap();
        assert_eq!(
            super::resolve_claude_session(home.path(), Some("/x/proj"), Some((300, 1_789_000_000)), false)
                .as_deref(),
            Some(guess)
        );
    }

    #[test]
    fn registry_rejects_mismatched_pid_bad_id_and_garbage() {
        let a = "11111111-1111-4111-8111-111111111111";
        assert_eq!(super::registry_session_uuid(&registry(101, a, 1_789_000_001_000), 100, 1_789_000_000), None);
        assert_eq!(
            super::registry_session_uuid(&registry(100, "not-a-uuid", 1_789_000_001_000), 100, 1_789_000_000),
            None
        );
        assert_eq!(super::registry_session_uuid(b"{", 100, 0), None);
        assert_eq!(super::registry_session_uuid(br#"{"pid":100}"#, 100, 0), None);
    }

    #[test]
    fn claude_slug_matches_claude_encoding() {
        // Every non-alphanumeric byte becomes '-', with no collapsing — so a
        // leading '/' and a '/.' both survive as literal dashes.
        assert_eq!(
            super::claude_slug("/Users/apple/Coding/Beecork/beecrok-terminal"),
            "-Users-apple-Coding-Beecork-beecrok-terminal"
        );
        assert_eq!(super::claude_slug("/Users/apple/.beecork-general"), "-Users-apple--beecork-general");
    }

    #[test]
    fn uuid_shaped_validates_form() {
        assert!(super::uuid_shaped("21c89373-22e7-4064-8ef4-543836557a64"));
        assert!(super::uuid_shaped("019f5c24-8fb9-7362-8187-28ffcef7688c"));
        assert!(!super::uuid_shaped("not-a-uuid"));
        assert!(!super::uuid_shaped("21c89373_22e7_4064_8ef4_543836557a64")); // wrong separators
        assert!(!super::uuid_shaped("21c89373-22e7-4064-8ef4-543836557a6")); // too short
        assert!(!super::uuid_shaped("g1c89373-22e7-4064-8ef4-543836557a64")); // non-hex
    }

    #[test]
    fn uuid_from_stem_handles_both_agents() {
        // Claude: the stem *is* the uuid.
        assert_eq!(
            super::uuid_from_stem("21c89373-22e7-4064-8ef4-543836557a64").as_deref(),
            Some("21c89373-22e7-4064-8ef4-543836557a64")
        );
        // Codex: `rollout-<iso-ts>-<uuid>` → the trailing 36 chars.
        assert_eq!(
            super::uuid_from_stem("rollout-2026-07-13T19-42-07-019f5c24-8fb9-7362-8187-28ffcef7688c")
                .as_deref(),
            Some("019f5c24-8fb9-7362-8187-28ffcef7688c")
        );
        assert_eq!(super::uuid_from_stem("session-notes"), None);
    }
}
