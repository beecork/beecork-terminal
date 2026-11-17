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
        Some(CMD_REQUEST) | None => default_candidates(),
        Some(program) => vec![program.to_string()],
    }
}

static CHAIN: OnceLock<Vec<String>> = OnceLock::new();

/// The platform default chain, resolved ONCE and off the IPC thread. Finding
/// PowerShell 7 walks `PATH` (a few `stat`s per entry, and an entry on a dead
/// network share can stall for a long time), so `lib.rs` calls this on a
/// background thread at startup, and `shell_info` — an async command — may call
/// it too. It BLOCKS until the walk is done: never call it from a sync command.
/// `pty_spawn` uses `default_candidates`.
pub(crate) fn resolved_default_candidates() -> &'static [String] {
    CHAIN.get_or_init(resolve_default_chain)
}

/// The default chain for a session starting NOW, without waiting. Normally that
/// is the resolved chain: the startup thread is done long before the first
/// terminal asks. While its walk is still running — the stalled `PATH` entry —
/// a session takes the chain without PowerShell 7 instead. Warming the lock is
/// not enough by itself: `OnceLock::get_or_init` parks every other caller until
/// the first one returns, so `pty_spawn`, a sync command, would sit on the IPC
/// thread behind the walk and the window would not respond. A first terminal
/// that opens Windows PowerShell is the better failure.
pub(crate) fn default_candidates() -> Vec<String> {
    match CHAIN.get() {
        Some(chain) => chain.clone(),
        None => quick_chain(),
    }
}

#[cfg(windows)]
fn resolve_default_chain() -> Vec<String> {
    let mut chain = quick_chain();
    if let Some(pwsh) = find_pwsh() {
        chain.insert(0, pwsh.to_string_lossy().into_owned());
    }
    chain
}

#[cfg(not(windows))]
fn resolve_default_chain() -> Vec<String> {
    vec![std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into())]
}

/// The default chain minus whatever has to be looked for: nothing here touches
/// the disk.
#[cfg(windows)]
fn quick_chain() -> Vec<String> {
    vec![windows_powershell(), comspec()]
}

#[cfg(not(windows))]
fn quick_chain() -> Vec<String> {
    resolve_default_chain()
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
    let on_path = std::env::var_os("PATH")
        .and_then(|path| first_on_path(&path, "pwsh.exe", is_launchable))
        .map(unshimmed);
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

/// Scoop puts a small stand-in `pwsh.exe` on `PATH` that only STARTS the real
/// one and waits for it; a `pwsh.shim` beside it names the real one. Launching
/// the stand-in works — but the process we would then hold is the stand-in,
/// whose working directory never moves, and that is the directory the status
/// poll reads: the file panel, git status and new tabs would freeze on the start
/// folder. So launch what it points at. (Written from Scoop's documented shim
/// format; not run against a Scoop install.)
#[cfg(windows)]
fn unshimmed(exe: PathBuf) -> PathBuf {
    std::fs::read_to_string(exe.with_extension("shim"))
        .ok()
        .and_then(|text| shim_target(&text))
        .filter(|target| is_launchable(target))
        .unwrap_or(exe)
}

/// The program a Scoop `.shim` file points at: its `path = …` line, quoted or
/// not. Pure, so it is unit-tested on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
fn shim_target(shim: &str) -> Option<PathBuf> {
    shim.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        if !key.trim().eq_ignore_ascii_case("path") {
            return None;
        }
        let value = value.trim().trim_matches('"').trim();
        (!value.is_empty()).then(|| PathBuf::from(value))
    })
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
/// It does NOTHING in a session that is not in `FullLanguage` mode. Where WDAC
/// or AppLocker enforce Constrained Language Mode, the two .NET calls below are
/// refused — `SetCurrentDirectory`, and `$Error.RemoveAt` in the `catch` meant
/// to tidy up after it — so the error escaped `prompt` on every command: the
/// user's prompt became a bare `PS>` and `$Error` grew by two records each time.
/// On such a machine PowerShell is left exactly as it is; the folder is then not
/// tracked (nothing that would track it is allowed there), which is the price.
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
///    local scripts run, unsigned downloaded ones are still blocked, and it is
///    PowerShell 7's own default. Process scope is an environment variable
///    (`PSExecutionPolicyPreference`), so it reaches this session AND every
///    PowerShell the session goes on to start — but nothing is written to the
///    registry, and no other terminal or program is affected. Any explicit
///    policy, including a deliberate `Restricted`, is left alone.
pub(crate) const POWERSHELL_HOOK: &str = concat!(
    "if ($ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage' -and ",
    "-not (Test-Path variable:global:__BeecorkPrompt)) { ",
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
    /// Default sessions ended up on Command Prompt: no PowerShell would start.
    cmd: bool,
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
    let current = started.unwrap_or_else(|| {
        resolved_default_candidates()
            .first()
            .cloned()
            .unwrap_or_default()
    });
    ShellInfo {
        windows: cfg!(windows),
        pwsh: is_pwsh(&current),
        cmd: shell_kind(&current) == ShellKind::Cmd,
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
            assert_eq!(got, default_candidates());
        }
    }

    #[test]
    fn the_default_chain_prefers_powershell_and_ends_in_cmd_on_windows() {
        let chain = resolved_default_candidates();
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

    // What a session gets while the PATH walk is still running: nothing that
    // has to be looked for, so nothing that can stall.
    #[test]
    fn the_chain_that_needs_no_lookup_has_no_pwsh() {
        let chain = quick_chain();
        assert!(!chain.is_empty());
        if cfg!(windows) {
            assert!(!chain.iter().any(|p| is_pwsh(p)), "{chain:?}");
            assert_eq!(shell_kind(&chain[0]), ShellKind::PowerShell, "{chain:?}");
            assert_eq!(chain.last(), Some(&comspec()), "{chain:?}");
        }
        // And asking for the default never fails, resolved yet or not.
        assert!(!default_candidates().is_empty());
    }

    #[test]
    fn a_scoop_shim_names_the_real_program() {
        let quoted =
            "path = \"C:\\Users\\me\\scoop\\apps\\pwsh\\current\\pwsh.exe\"\r\nargs = -NoLogo\r\n";
        assert_eq!(
            shim_target(quoted),
            Some(PathBuf::from(
                "C:\\Users\\me\\scoop\\apps\\pwsh\\current\\pwsh.exe"
            ))
        );
        // Older shims write the path bare.
        assert_eq!(
            shim_target("path = C:\\tools\\pwsh.exe\n"),
            Some(PathBuf::from("C:\\tools\\pwsh.exe"))
        );
        // Nothing usable: keep what was found on PATH.
        assert_eq!(shim_target("args = -NoLogo\n"), None);
        assert_eq!(shim_target("path = \n"), None);
        assert_eq!(shim_target(""), None);
    }

    // The hook under Constrained Language Mode (WDAC / AppLocker), where its
    // .NET calls are refused. It must not install itself: the session's own
    // prompt keeps working and nothing lands in $Error. Simulated by setting the
    // language mode before the hook runs; a real policy sets it before anything.
    // Windows-only, like the end-to-end test in pty.rs: run `cargo test` here.
    #[cfg(windows)]
    #[test]
    fn the_hook_leaves_a_constrained_powershell_alone() {
        let run = |before: &str| {
            let script = format!(
                "{before}{POWERSHELL_HOOK}; $p = prompt; $q = prompt; \
                 'HOOKED=' + (Test-Path variable:global:__BeecorkPrompt); \
                 'PROMPT=' + $q; 'ERRORS=' + $Error.Count"
            );
            let out = std::process::Command::new(windows_powershell())
                .args(["-NoProfile", "-NonInteractive", "-Command", &script])
                .env_remove("PSExecutionPolicyPreference")
                // Whatever runs the tests may itself sit under PowerShell 7,
                // whose module path Windows PowerShell cannot load from.
                .env_remove("PSModulePath")
                .output()
                .expect("Windows PowerShell ships with Windows");
            String::from_utf8_lossy(&out.stdout).into_owned()
                + &String::from_utf8_lossy(&out.stderr)
        };

        let constrained =
            run("$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; ");
        assert!(constrained.contains("HOOKED=False"), "{constrained}");
        assert!(constrained.contains("PROMPT=PS "), "{constrained}");
        assert!(constrained.contains("ERRORS=0"), "{constrained}");

        // The control: in an ordinary session the same line does install itself,
        // and still leaves no error behind.
        let full = run("");
        assert!(full.contains("HOOKED=True"), "{full}");
        assert!(full.contains("PROMPT=PS "), "{full}");
        assert!(full.contains("ERRORS=0"), "{full}");
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
