// Which shell a new session runs, and how it is launched.
//
// Windows is the interesting platform. Every session used to run `COMSPEC` —
// cmd.exe on practically every machine — so the PowerShell commands that agents,
// docs and search results hand Windows users failed with "not recognized". The
// default is now PowerShell (7 when installed, else the built-in 5.1), with cmd
// one Settings choice away. Getting there took more than swapping the program:
// see `POWERSHELL_HOOK` for the two things a bare PowerShell breaks.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::pty::{shell_kind, ShellKind};

/// The one shell name the webview may send (`pty_spawn`'s `shell`): "the user
/// picked Command Prompt in Settings". Anything else the webview might send is
/// taken as a program, as before; `None` is the platform default. Resolved here,
/// not in the webview, because only Rust knows what is actually installed.
pub(crate) const CMD_REQUEST: &str = "cmd";

/// Programs to try, in order, for a session. `pty_spawn` starts the first one
/// that launches, so a broken PowerShell (an app-execution alias left behind by
/// an uninstall, an AppLocker rule) degrades to the next shell instead of a pane
/// that fails to start on every keypress.
pub(crate) fn candidates(requested: Option<&str>) -> Vec<String> {
    match requested {
        // Command Prompt exactly as before this change: `COMSPEC`. Off Windows
        // there is no cmd, so a stale setting falls back to the default.
        Some(CMD_REQUEST) if cfg!(windows) => vec![comspec()],
        Some(CMD_REQUEST) | None => default_candidates().to_vec(),
        Some(program) => vec![program.to_string()],
    }
}

/// The platform default chain, resolved ONCE. Finding PowerShell 7 walks `PATH`
/// (a few `stat`s per entry, and an entry on a dead network share can stall),
/// and `pty_spawn` is a sync command on the IPC thread — so `lib.rs` warms this
/// on a background thread at startup and every later call is a memory read.
pub(crate) fn default_candidates() -> &'static [String] {
    static CHAIN: OnceLock<Vec<String>> = OnceLock::new();
    CHAIN.get_or_init(resolve_default_chain)
}

#[cfg(windows)]
fn resolve_default_chain() -> Vec<String> {
    let mut chain: Vec<String> = Vec::with_capacity(3);
    if let Some(pwsh) = find_pwsh() {
        chain.push(pwsh.to_string_lossy().into_owned());
    }
    chain.push(windows_powershell());
    chain.push(comspec());
    chain
}

#[cfg(not(windows))]
fn resolve_default_chain() -> Vec<String> {
    vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())]
}

/// `COMSPEC`, i.e. cmd.exe — what every session ran before PowerShell became
/// the default, and still the last resort of the default chain.
fn comspec() -> String {
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
}

/// Windows PowerShell 5.1 by absolute path. It ships with every Windows since
/// 10, so this is the dependable default; the absolute path keeps a
/// `powershell.exe` planted earlier on `PATH` from being picked up instead.
#[cfg(windows)]
fn windows_powershell() -> String {
    match std::env::var_os("SystemRoot") {
        Some(root) => Path::new(&root)
            .join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
            .to_string_lossy()
            .into_owned(),
        None => "powershell.exe".into(),
    }
}

/// PowerShell 7 (`pwsh.exe`), when installed: `PATH` first, so a user who put a
/// preview build ahead of the stable one gets what they chose, then the MSI's
/// default location in case the installer was told not to touch `PATH`.
#[cfg(windows)]
fn find_pwsh() -> Option<PathBuf> {
    let on_path =
        std::env::var_os("PATH").and_then(|path| first_on_path(&path, "pwsh.exe", is_launchable));
    on_path.or_else(|| {
        let pf = std::env::var_os("ProgramFiles")?;
        let msi = Path::new(&pf).join(r"PowerShell\7\pwsh.exe");
        is_launchable(&msi).then_some(msi)
    })
}

/// The first `PATH` entry holding `exe`. RELATIVE entries are skipped: they
/// resolve against the app's own cwd, so `.` on `PATH` would let a `pwsh.exe`
/// sitting in whatever folder the app was launched from become every session's
/// shell. Pure apart from `exists`, so it is unit-tested on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
fn first_on_path(path: &OsStr, exe: &str, exists: impl Fn(&Path) -> bool) -> Option<PathBuf> {
    std::env::split_paths(path)
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(exe))
        .find(|candidate| exists(candidate))
}

/// A file we can hand to CreateProcess. The Microsoft Store / winget build of
/// pwsh is an app-execution alias in `WindowsApps` — a reparse point that
/// `metadata` may refuse to follow — so fall back to the entry itself.
#[cfg(windows)]
fn is_launchable(p: &Path) -> bool {
    match std::fs::metadata(p) {
        Ok(m) => m.is_file(),
        Err(_) => std::fs::symlink_metadata(p)
            .map(|m| !m.is_dir())
            .unwrap_or(false),
    }
}

/// Extra arguments for the shell program. Unix's `-l` stays in `pty_spawn`
/// (it is about login profiles, not about any one shell); this is Windows-only.
pub(crate) fn launch_args(program: &str) -> &'static [&'static str] {
    if cfg!(windows) && shell_kind(program) == ShellKind::PowerShell {
        // -NoExit keeps the shell interactive after the hook runs; -Command (not a
        // script file) is not subject to the execution policy, and runs AFTER the
        // user's profile, so the hook wraps whatever prompt the profile defined.
        &["-NoLogo", "-NoExit", "-Command", POWERSHELL_HOOK]
    } else {
        &[]
    }
}

/// Run once in every PowerShell session, after the user's profile. One line, no
/// double quotes — it reaches PowerShell through CreateProcess quoting, and both
/// are pinned by a test. It fixes the two things a bare PowerShell breaks:
///
/// 1. FOLDER TRACKING. The file panel, git status and new tabs follow a session
///    by reading the shell process's working directory from the OS
///    (`statuses_for` in `pty.rs`). cmd's `cd` changes that; PowerShell's
///    `Set-Location` does NOT — it moves PowerShell's own location and leaves
///    the process where it started, so every panel would freeze on the start
///    folder. The hook wraps `prompt` (which runs after every command) and copies
///    the location into the process cwd. Only for the FileSystem provider (a
///    registry location has no folder); errors are swallowed and removed from
///    `$Error`, because a prompt that throws is worse than a stale panel. The
///    prompt's `$?` is restored before the user's own prompt runs, so themes
///    that colour a failed command (oh-my-posh, starship) still see it. Same
///    trade-off as cmd: Windows will not delete a folder a process is sitting in.
///
/// 2. SCRIPTS. Windows PowerShell 5.1 ships with execution policy `Restricted`,
///    and npm, npx, pnpm and yarn install as `.ps1` shims that PowerShell prefers
///    over their `.cmd` twins — so on a fresh PC `npm` fails with "running scripts
///    is disabled on this system" in PowerShell while working in cmd. ONLY when
///    no scope sets a policy at all (no Group Policy, no user or admin choice —
///    the untouched default), this session gets `RemoteSigned` at Process scope:
///    local scripts run, unsigned downloaded ones are still blocked, it is
///    PowerShell 7's own default, and nothing outside this process changes. Any
///    explicit policy, including a deliberate `Restricted`, is left alone.
pub(crate) const POWERSHELL_HOOK: &str = concat!(
    "if (-not (Test-Path variable:global:__BeecorkPrompt)) { ",
    "try { ",
    "if (-not (Get-ExecutionPolicy -List | Where-Object { $_.ExecutionPolicy -ne 'Undefined' })) { ",
    "Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force -ErrorAction Stop ",
    "} ",
    "} catch { if ($global:Error.Count) { $global:Error.RemoveAt(0) } }; ",
    "$global:__BeecorkPrompt = $function:prompt; ",
    "function global:prompt { ",
    "$beecorkOk = $global:?; ",
    "try { if ($PWD.Provider.Name -eq 'FileSystem') { [System.IO.Directory]::SetCurrentDirectory($PWD.ProviderPath) } } ",
    "catch { if ($global:Error.Count) { $global:Error.RemoveAt(0) } }; ",
    "if (-not $beecorkOk) { Write-Error '' -ErrorAction Ignore }; ",
    "if ($global:__BeecorkPrompt) { & $global:__BeecorkPrompt } else { 'PS ' + $PWD.Path + '> ' } ",
    "} ",
    "}",
);

#[derive(Serialize)]
pub struct ShellInfo {
    /// Windows — the only platform with a shell choice in Settings.
    windows: bool,
    /// Default sessions run PowerShell 7 (Settings suggests it when they don't —
    /// not installed, or installed but failing to start).
    pwsh: bool,
    /// What a default session runs, for Settings to name.
    default_name: String,
}

/// The program the last DEFAULT session actually started — not necessarily the
/// first candidate: a pwsh that is found but will not launch falls through to
/// Windows PowerShell, and Settings must name what really runs.
static STARTED_DEFAULT: Mutex<Option<String>> = Mutex::new(None);

/// Called by `pty_spawn` after a default (no explicit shell) session started.
pub(crate) fn record_started_default(program: &str) {
    // Survive a poisoned lock (see `sessions()` in pty.rs): it holds one value
    // replaced wholesale, so a panic can leave it stale but never torn.
    *STARTED_DEFAULT.lock().unwrap_or_else(|e| e.into_inner()) = Some(program.to_string());
}

/// What Settings needs to render the shell choice. Async: the first call may be
/// the one that walks `PATH` (see `default_candidates`).
#[tauri::command(async)]
pub fn shell_info() -> ShellInfo {
    let started = STARTED_DEFAULT
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let current =
        started.unwrap_or_else(|| default_candidates().first().cloned().unwrap_or_default());
    ShellInfo {
        windows: cfg!(windows),
        pwsh: is_pwsh(&current),
        default_name: display_name(&current),
    }
}

fn is_pwsh(program: &str) -> bool {
    let base = crate::fs::basename(program).to_ascii_lowercase();
    base == "pwsh.exe" || base == "pwsh"
}

fn display_name(program: &str) -> String {
    match shell_kind(program) {
        ShellKind::PowerShell if is_pwsh(program) => "PowerShell 7".into(),
        ShellKind::PowerShell => "Windows PowerShell".into(),
        ShellKind::Cmd => "Command Prompt".into(),
        ShellKind::Posix => crate::fs::basename(program).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_program_is_passed_through_untouched() {
        assert_eq!(candidates(Some("/bin/bash")), vec!["/bin/bash".to_string()]);
    }

    #[test]
    fn the_cmd_choice_is_comspec_on_windows_and_the_default_elsewhere() {
        let got = candidates(Some(CMD_REQUEST));
        if cfg!(windows) {
            assert_eq!(got, vec![comspec()]);
        } else {
            assert_eq!(got, default_candidates().to_vec());
        }
    }

    #[test]
    fn the_default_chain_prefers_powershell_and_ends_in_cmd_on_windows() {
        let chain = default_candidates();
        assert!(!chain.is_empty());
        if cfg!(windows) {
            assert_eq!(shell_kind(&chain[0]), ShellKind::PowerShell, "{chain:?}");
            assert_eq!(
                chain.last(),
                Some(&comspec()),
                "cmd is the last resort: {chain:?}"
            );
            // pwsh, when present, comes before Windows PowerShell — never after.
            let pwsh = chain.iter().position(|p| is_pwsh(p));
            assert!(pwsh.is_none() || pwsh == Some(0), "{chain:?}");
        }
    }

    #[test]
    fn path_search_skips_relative_entries() {
        let rel = PathBuf::from("bin");
        let abs = std::env::temp_dir().join("beecork-bin");
        let path = std::env::join_paths([rel.clone(), abs.clone()]).unwrap();
        // Both "contain" pwsh.exe; only the absolute one may win.
        let found = first_on_path(&path, "pwsh.exe", |_| true);
        assert_eq!(found, Some(abs.join("pwsh.exe")));
        // Nothing launchable anywhere → None (falls through to the next shell).
        assert_eq!(first_on_path(&path, "pwsh.exe", |_| false), None);
    }

    #[test]
    fn powershell_gets_the_hook_and_nothing_else_does() {
        for program in ["cmd.exe", "C:\\Windows\\System32\\cmd.exe", "/bin/zsh"] {
            assert!(launch_args(program).is_empty(), "{program}");
        }
        for program in [
            "powershell.exe",
            "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        ] {
            let args = launch_args(program);
            if cfg!(windows) {
                assert_eq!(args.last(), Some(&POWERSHELL_HOOK), "{program}");
                assert!(args.contains(&"-NoExit"), "the shell must stay interactive");
            } else {
                assert!(args.is_empty(), "the hook is Windows-only: {program}");
            }
        }
    }

    // The hook travels as ONE CreateProcess argument and is re-parsed by
    // PowerShell's own command-line handling. A `"` would need escaping that 5.1
    // and 7 disagree on, and a newline would split it; neither may ever appear.
    #[test]
    fn the_hook_survives_command_line_quoting() {
        assert!(!POWERSHELL_HOOK.contains('"'));
        assert!(!POWERSHELL_HOOK.contains('\n') && !POWERSHELL_HOOK.contains('\r'));
        // Balanced braces/parens — a typo here is a parse error in every new tab.
        let count = |c| POWERSHELL_HOOK.matches(c).count();
        assert_eq!(count('{'), count('}'));
        assert_eq!(count('('), count(')'));
    }

    #[test]
    fn display_names() {
        assert_eq!(
            display_name("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
            "PowerShell 7"
        );
        assert_eq!(
            display_name("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
            "Windows PowerShell"
        );
        assert_eq!(
            display_name("C:\\Windows\\system32\\cmd.exe"),
            "Command Prompt"
        );
        assert_eq!(display_name("/bin/zsh"), "zsh");
    }
}
