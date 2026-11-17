# Windows: PowerShell as the default shell

*Status: implemented on `feat/windows-powershell-default`. Discussed and built 2026-11-16.*

## Intention

On Windows every Beecork tab ran Command Prompt (cmd). Make PowerShell the
default, keep cmd one Settings choice away, and make sure nothing that works with
cmd today breaks with PowerShell.

## Why

Agents, docs and search results give Windows users PowerShell commands. Pasted
into a Beecork tab they failed with "not recognized", because the tab ran cmd.
This happened regularly, not once.

## How it was (verified in code)

- `default_shell()` in `pty.rs` used `COMSPEC`, which is `cmd.exe` on practically
  every machine; its `powershell.exe` fallback effectively never ran.
- The webview never chose a shell (`TerminalPane` sent `shell: null`).
- PowerShell was already handled correctly once running: `ShellKind`,
  `quote_for_shell`, and `cd_line` (`Set-Location -LiteralPath`), all tested.

## What a plain switch would have broken (both found and fixed)

1. **Folder tracking.** The file panel, git status and new tabs follow a session
   by reading the shell process's OS-level working directory every ~2s
   (`statuses_for`). cmd's `cd` updates it. PowerShell's `Set-Location` does NOT,
   so the panel would have frozen on the start folder. (OSC 7 was considered and
   rejected: the 2s poll overwrites whatever OSC 7 reports with the stale OS
   value, and `parseOsc7` turns `file:///C:/x` into `/C:/x`.) Fix: a prompt hook
   copies `$PWD` into the process cwd after every command.
2. **npm.** Windows PowerShell 5.1 ships with execution policy `Restricted`, and
   npm/npx/pnpm/yarn install `.ps1` shims that PowerShell prefers over `.cmd`.
   Confirmed on a real machine: `npm --version` fails in a plain 5.1. Fix: only
   when no scope sets any policy (the untouched default), the session gets
   Process-scope `RemoteSigned`. Any explicit policy, including Group Policy, is
   left alone, and nothing outside that process changes.

## Decision (as built)

- **Default:** PowerShell 7 (`pwsh`) if installed (PATH, absolute entries only,
  then Program Files), else Windows PowerShell 5.1 by absolute path, else
  `COMSPEC`. Each is tried in turn, so a broken pwsh falls back to the next shell
  and the fallback is noted in the local log.
- **Option:** Settings → Shell → PowerShell / Command Prompt. Command Prompt is
  exactly the old behaviour (`COMSPEC`).
- **PowerShell 7 suggestion:** when default tabs aren't running PowerShell 7,
  Settings links Microsoft's install page. Considered and rejected: having the
  installer push PowerShell 7. Too heavy, often blocked on company PCs, and
  5.1-only users still need npm to work.

## Alternatives considered

- **Do nothing / type `powershell` when needed:** the problem keeps coming
  back, and folder tracking would be broken inside that PowerShell.
- **cmd default + PowerShell option:** new users still hit the mismatch.
- **Never touch the execution policy:** npm broken out of the box on 5.1.

## Costs and known trade-offs

- PowerShell starts a little slower than cmd.
- Like cmd, a session pins its current folder: Windows won't delete a folder a
  process is sitting in.
- A user's own profile blocked by their execution policy still prints its error.
  That's their setting, unchanged by us.
- In PowerShell's ConstrainedLanguage mode (AppLocker), the folder hook degrades
  silently (the panel stays put) rather than erroring.

## Verification

- Rust: unit tests for the chain, PATH search, launch args and hook quoting, plus
  `powershell_sessions_follow_cd_and_can_run_local_scripts`, an end-to-end test
  through a real ConPTY for every installed PowerShell. Windows-only; CI only
  type-checks it.
- Frontend: 3 new tests for the setting → `pty_spawn` shell argument.
- In the real app (dev build, driven through WebView2 DevTools): PowerShell 7.7
  and 5.1 tabs, `npm --version`, `claude --version`, the file panel following
  `cd`, the fallback past a broken `pwsh.exe`, the Settings screen in both states,
  and switching to Command Prompt and back.

## Seen along the way, not changed

- In the dev build, the first tab after a launch or page reload sometimes shows
  "process exited — press any key". Reproduced identically on unmodified `main`
  with cmd, so it predates this change.
- `parseOsc7` returns `/C:/x` for a Windows `file:///C:/x` URL (pinned by a test
  as-is). It doesn't matter for this change, which doesn't use OSC 7.
