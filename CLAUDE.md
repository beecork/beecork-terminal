# CLAUDE.md — Beecork Terminal

A rules index, not documentation. Almost every line below is an invariant that
has already been broken once and cost a release. The implementing file is named —
read it before changing that mechanism.

## PTY (`src-tauri/src/pty.rs`)

- **`pty_write` stays `#[tauri::command]` (sync) and enqueue-only.** It sends to a
  per-session writer thread and returns; that thread is the only thing that
  blocks. Making it `command(async)` would put keystrokes on a threadpool where
  they can reorder, and writing inline lets a child that isn't draining stdin
  stall the IPC thread. Twelve other commands *are* deliberately async — this one
  is not.
- **Submit lines with `\r`, never `\n`.** `\r` is what Enter sends and the only
  byte Windows ConPTY (cmd.exe / PowerShell) accepts as "run this line". `\n`
  works on macOS/Linux and leaves the command typed-but-unrun on Windows.
  Pinned by `cd_line_submits_with_a_carriage_return_in_every_shell`.
- **`cd` is not one command.** PowerShell needs `Set-Location -LiteralPath` (its
  `-Path` wildcard-matches `[ ]` even inside quotes); cmd needs `cd /d` or
  changing drive silently does nothing. See `cd_line`.
- **Quote paths for the shell the session actually runs** — `quote_for_shell`,
  keyed on `ShellKind`. Never emit POSIX single quotes unconditionally; cmd takes
  them literally. The webview must not make this decision — it can only guess
  from a user-agent string, and "Windows" is two incompatible shells.
- **Spawn a login shell (`-l`) on unix.** Without it `~/.zprofile` never runs,
  Homebrew never enters PATH, and CLIs report `ffmpeg`/`sox`/`gh` as missing
  though they're installed.
- **Give the child a clean identity** — `TERM_PROGRAM=Beecork`, and scrub the host
  terminal's markers. An inherited `TERM_PROGRAM=Apple_Terminal` makes
  `/etc/zshrc` run Apple's shell-session integration inside our pty. (Consequence
  worth knowing: this is also why OSC 7 never fires for a default zsh, so the
  status poll is the real cwd source — see `currentCwd` in `TerminalPane`.)
- **Force a UTF-8 locale when the environment has none.** A Finder-launched `.app`
  inherits no locale, which is why multibyte output garbled only in the installed
  app and never under `tauri dev`.
- **Sessions are window-local.** Each handle records its owning window label and
  `kill_by_owner` reaps only that window's sessions. A ⌘N window must never reap
  the first window's shells.

## Attention & status (`src/lib/useSessionStatus.ts`)

- **Attention keys off *visibility*, not focus.** A pane you can see is "seen" —
  in a split, both count. Keying on `activeId` re-lights the pane you're looking
  at. Visibility is re-checked when the timer FIRES, not when it was armed.
- **Two-stage quiet timers; don't collapse them.** `QUIET_MS` (1500) turns the
  busy dot off. Inferring "needs you" additionally requires `ATTN_QUIET_MS` (6000)
  of silence after a streak of at least `WORK_MIN_MS` (2500) — flagging at
  `QUIET_MS` chimed in the *middle* of agent turns. `INFER_RECHIME_MS` (60s)
  rate-limits **inferred** chimes only; bell and command-exit are precise signals
  and always chime. All of this is pinned by `useSessionStatus.test.ts`.
- **Status replies need a per-session ordering guard** (`lib/latest.ts`). The
  commands are `command(async)`, so replies arrive in completion order, not call
  order. The key is the SESSION, not the call — one `pty_status_all` reply carries
  many sessions, so a global epoch would discard fresh data for all the others.

## Sound (`src/lib/sound.ts`, `src-tauri/src/sound.rs`)

- **Audio is synthesized and played in Rust. Never Web Audio.** WKWebView suspends
  and zombifies a backgrounded page's `AudioContext`; sound died silently over
  time and only a fresh window brought it back. `sound.ts` is policy only.
- **Do the action first, then play the sound — and wrap the call.** Ordering alone
  is not enough: an exception escaping the handler aborts React's pending state
  flush too, so the flag you just set never commits. Both are required.

## Terminal pane (`src/components/TerminalPane.tsx`)

- **Build the xterm lazily, latched during render.** Every session renders a pane
  so its shell keeps running, but a pane never opened must not build a Terminal +
  WebGL context — a webview grants only a handful of GL contexts. Latch in render,
  not an effect, or the first paint is an empty pane.
- **Skip WebGL on Windows.** WebView2's GPU path ghosts cells on in-place redraws;
  xterm's DOM renderer is correct there. macOS/Linux keep WebGL and dispose the
  addon on context loss.
- **Reset stuck DEC private modes when a child dies.** A child killed mid-run
  leaves mouse tracking on, and the next shell echoes every mouse move as growing
  `\e[<35;…M` gibberish.
- **Anything read from inside the mount effect must come from a ref.** The link
  provider's `activate` and `spawn` closures are built ONCE, so a prop read
  directly in them freezes at first-visible — the change looks right and does
  nothing.

## CSS (`src/App.css`) — these overrides are load-bearing

- **The terminal's scrollbar is xterm 6's own.** Don't hide it, reimplement it, or
  style it outside `xtermTheme()`.
- **Do not force `.xterm-screen`'s height.** In xterm 6 the screen sits inside
  `.xterm-scrollable-element`; forcing 100% collapses that wrapper — and the
  scrollbar — to zero height.
- **`.xterm-viewport` must be transparent.** xterm 6 leaves it at its `#000`
  default, which reads as a black band in the scrollbar gutter.

## Hostile-repository hardening

The app runs `git` automatically in whatever folder the terminal is in, so a
repo's config is attacker-controlled input.

- **Every `git` call goes through `git()`** — `--no-optional-locks` plus
  `-c core.fsmonitor=false -c core.pager=cat`. Both settings are RCE vectors; the
  lock flag also keeps our background `git status` from racing the agent's own
  git, and blocks the index write that would fire a `post-index-change` hook.
- **`git status` additionally neutralizes filter drivers** (`filter_neutralizers`),
  enumerated with `config --list` across **all scopes** — `--local` does not expand
  `include.path`, so a driver hidden in an included file lists clean and the
  obvious fix is bypassable with one config line.
- **`write_file` refuses to write through a symlink leaf**; `read_file` requires a
  regular file and rejects NUL bytes, >2 MB, and non-UTF-8. Tested in `fs.rs`.
- **The watcher refuses filesystem-wide roots** — a Finder-launched app has cwd
  `/`, and watching that walks the whole disk.
- **Never launch a URL through a shell.** `cmd /C start` re-parses `&`/`|`/`^` and
  expands `%VAR%`, and URLs come from terminal output. Windows goes through
  `tauri_plugin_opener::open_url` (ShellExecuteExW).

## Backend command threading

- **Anything that shells out, touches disk, or scans the process table is
  `#[tauri::command(async)]`.** A plain `#[tauri::command]` runs INLINE on the
  IPC/main thread and is felt as a frozen window. Two deliberate exceptions: pure
  env lookups (`get_root`, `home_dir`), where the hop costs more than the work,
  and `pty_write` (see above).

## Paths (`src/lib/paths.ts`)

- **Every path helper is separator-agnostic.** The backend hands us *native*
  paths, so Windows paths arrive with backslashes. A POSIX-only `split("/")`
  silently returns the whole path as a basename, an empty dirname (new files land
  at the drive root), and never matches an ancestor. Helpers that must agree with
  each other should compose (`isDirectChild` goes through `dirname`), not
  re-normalize by hand.

## Releasing (`RELEASING.md`)

- **Bump the version in all four files**: `package.json`,
  `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`
  (plus `package-lock.json`, which `npm install` refreshes). CI checks all five.
- **The tag must be annotated** (`git tag -a`) — `--follow-tags` pushes only
  annotated tags, so a lightweight one is silently left behind.
- **Pushing the tag does not *reliably* start the build** — it has been ~20
  minutes late, and it has also fired promptly and produced a second run racing a
  dispatched one. Dispatch rather than wait: `gh workflow run release.yml --ref
  vX.Y.Z`, cancel the duplicate if one appears, then confirm with `gh release
  view` that it actually published. v0.1.24 built green and never shipped.
- **Never regenerate the updater signing key.** The public key in
  `tauri.conf.json` must match the private key in repo secrets and in every
  installed copy, or all existing installs reject every future update.

## Working conventions

- **Comments here are binding contracts.** These invariants survive across agent
  sessions only because the code says *why*. If you change a mechanism, change the
  comment describing it in the same commit.
- **Node ≥ 22.22.2** (`package.json` engines, enforced by `.npmrc`). jsdom's
  bundled undici calls `webidl.util.markAsUncloneable`, absent in Node 20, so the
  test worker can't even start — and the error points nowhere near the Node version.
- **ESLint is scoped on purpose** (`eslint.config.js`): `tsc` already covers dead
  variables and types, so the config keeps the React-hooks rules and switches off
  the duplicates. `react-hooks/refs` is off deliberately — the latest-ref pattern
  is load-bearing here; the reasoning is written in the config.
- **`audits/` is gitignored.** Audit reports are local-only.
