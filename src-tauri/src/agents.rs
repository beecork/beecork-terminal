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

/// Claude Code names a project's transcript folder by its cwd with every non
/// -alphanumeric byte turned into `-` (no collapsing: `/Users/x/.foo` →
/// `-Users-x--foo`). Mirror that exactly so we can find the folder for a cwd.
fn claude_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// `~/.claude/projects/<slug>/` for a cwd, iff it exists.
fn claude_project_dir(cwd: &str) -> Option<std::path::PathBuf> {
    let dir = crate::fs::home()?.join(".claude").join("projects").join(claude_slug(cwd));
    dir.is_dir().then_some(dir)
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
/// Claude: newest transcript in its per-cwd folder (cheap); when two Claude tabs
/// share a folder (`disambiguate`), try the exact open-file lookup first. Codex:
/// its sessions aren't foldered by cwd, so there's no cheap fallback — we can
/// only pin the exact chat while codex still holds its rollout open. `None` → the
/// frontend keeps the generic `--continue` / `codex resume`.
pub fn resolve_agent_session(
    agent: &str,
    cwd: Option<&str>,
    fg_cmd: Option<u32>,
    disambiguate: bool,
) -> Option<String> {
    match agent {
        "claude" => {
            if disambiguate {
                if let Some(uuid) = fg_cmd.and_then(lsof_transcript_uuid) {
                    return Some(uuid);
                }
            }
            newest_transcript_uuid(&claude_project_dir(cwd?)?)
        }
        "codex" => fg_cmd.and_then(lsof_transcript_uuid),
        _ => None,
    }
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

    // Per-tab agent resume rides on this: `lsof` usually misses (Claude opens and
    // closes its transcript per append), so mtime-newest is the workhorse.
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
