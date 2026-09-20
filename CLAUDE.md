# CLAUDE.md — Beecork Terminal

A rules index, not documentation. Almost every line below is an invariant that
has already been broken once and cost a release. The implementing file is named —
read it before changing that mechanism.

## PTY (`src-tauri/src/pty.rs`)

- **`pty_write` stays `#[tauri::command]` (sync) and enqueue-only.** It sends to a
  per-session writer thread and returns; that thread is the only thing that
  blocks. Making it `command(async)` would put keystrokes on a threadpool where
  they can reorder, and writing inline lets a child that isn't draining stdin
  stall the IPC thread. Most other commands *are* deliberately async — this one is
  not. (Don't put a count here: the last one said "twelve" and was wrong by the
  time `log_event` landed. The sync exceptions are listed under "Backend command
  threading".)
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
- **`portable_pty::Child::kill` is a SIGHUP plus a 200 ms grace loop, not a
  SIGKILL.** On unix it signals SIGHUP, then polls `try_wait` five times with
  `thread::sleep(50ms)` between attempts before escalating to SIGKILL. The first
  poll runs microseconds after the signal, so ~50 ms is the ROUTINE cost of
  killing a live session — not an edge case, and `kill_by_owner` multiplied it by
  the pane count on the MAIN thread at window close. Never call it on the IPC or
  main thread; every reap goes through `reap_detached`, which sends the signal
  synchronously (via `clone_killer`, which skips the grace loop) and hands the
  escalation and the `wait()` to a thread. It signals the child PID only, never
  its process group.
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
- **A quiet timer that fired late proves nothing** (`firedLate`). macOS freezes a
  backgrounded / minimised / display-asleep window's timers and releases them all
  on resume, so a 1.5s timer can land hours later. The silence it measured is the
  app being frozen — and the output it "missed" is still queued in the channel.
  Both quiet stages check their own arming time; the precise producers (bell,
  command exit) are untouched and still fire on resume.
- **`running: null` is two different answers, so the backend labels which**
  (`running_known` in `pty.rs`). The shell being idle at its prompt reads as "your
  command finished — come look" and always chimes; a tick that could not READ the
  foreground command must never say that. The UI holds the previous value instead
  — including the agent id "Resume" needs. Every no-answer path is `false`: an
  unreadable foreground pid, `tcgetpgrp` returning nothing, Windows (no such
  concept), and `ptyStatus`'s missing-session fallback in `api.ts`.
- **Status replies need a per-session ordering guard** (`lib/latest.ts`). The
  commands are `command(async)`, so replies arrive in completion order, not call
  order. The key is the SESSION, not the call — one `pty_status_all` reply carries
  many sessions, so a global epoch would discard fresh data for all the others.

## Sound (`src/lib/sound.ts`, `src-tauri/src/sound.rs`)

- **Audio is synthesized and played in Rust. Never Web Audio.** WKWebView suspends
  and zombifies a backgrounded page's `AudioContext`; sound died silently over
  time and only a fresh window brought it back. `sound.ts` is policy only.
- **Do the action first, then play the sound — and wrap the call.** A throwing
  sound call just ends the handler: everything after it is skipped. That is plain
  control flow, not a React mechanism (React 19 queues its state flush as a
  microtask, which a later synchronous throw cannot cancel), and it costs more
  than state — `onBell` lights the dot, chimes, and only then fires the OS
  notification, so a chime placed first would lose the notification too.
  `sound.ts` is fire-and-forget today (`invoke` is `async`, the rejection is
  swallowed) and cannot throw synchronously; it was synchronous Web Audio until
  v0.1.15, so the `try/catch` stays as insurance against a regression reaching
  whatever comes after. Pinned by "action before sound (flagWants)" in
  `useSessionStatus.test.ts`.

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
- **Linkify the LOGICAL line, not the buffer row.** xterm calls `provideLinks`
  with one row at a time, and a path longer than the pane wraps: per row the head
  has no extension (PATH_RE never sees a path) and the tail matches as a
  *relative* one, which `openToken` re-roots at the session cwd — the click opens
  a file that cannot exist ("No preview available" on a screenshot that is right
  there on screen). Rejoin the continuation rows (`isWrapped`) before matching,
  and give every row but the last its full width — no right-trim, explicit
  `cols` — or every offset past the join shifts and the range underlines the
  wrong cells. A link range may legally span rows (`_linkAtPosition` compares
  flat buffer offsets), so hover, underline and click all follow it. Pinned by
  the two wrapped-link tests in `TerminalPane.test.tsx`.
- **Anything read from inside the mount effect must come from a ref.** The link
  provider's `activate` and `spawn` closures are built ONCE, so a prop read
  directly in them freezes at first-visible — the change looks right and does
  nothing.
- **Repaint a pane when it comes back on screen** (`redrawViewport`). xterm parks
  its renderer on an IntersectionObserver while a pane is `display:none` and, on
  resume, redraws only if a refresh was REQUESTED while it was away — an idle
  background tab requests nothing, so it comes back with zero draw calls, and
  `fit()` is a no-op when the geometry hasn't changed. The canvas is not
  guaranteed to have kept its picture that long (same hazard as moving a pane's
  DOM node — see `terminalOrder`), so the pane shows background plus only the rows
  something redrew afterwards. Repaint on show, again after `REDRAW_SETTLE_MS`
  (the first can share a frame with the layer rebuild that wipes it), and on
  window wake. Pinned by the two repaint tests in `TerminalPane.test.tsx`.

- **Re-upload the WebGL texture atlas whenever xterm reshapes its page array**
  (`resyncAtlasTextures`). Every pane shares ONE atlas — `acquireTextureAtlas`
  matches on font/size/theme/DPR — but each holds its own GPU copy and decides a
  slot is current by comparing `page.version`, a PER-PAGE counter, against the
  version it recorded for that SLOT. Merging (at `MAX_TEXTURE_IMAGE_UNITS` pages)
  splices pages out, so a slot ends up holding a different page whose counter is
  compared with the previous occupant's: equal by chance skips the upload and the
  pane draws the old page's picture with the new page's coordinates — letters as
  fragments of OTHER letters, in those letters' colours, permanently and
  identically everywhere that character appears. Only resize/DPR/theme reach
  `setAtlas()`, which is why resizing the window was the only cure. Re-assigning
  `options.theme` is that same path minus the geometry; it must be a FRESH object
  (the option setter compares identity) and deferred out of the frame (the events
  fire from inside xterm's model update). Fixed upstream in addon-webgl 0.20.0 by
  making the counter globally monotonic — drop this when that ships stable.
  Pinned by the four atlas re-sync tests in `TerminalPane.test.tsx`.

## CSS (`src/App.css`) — these overrides are load-bearing

- **The terminal's scrollbar is xterm 6's own.** Don't hide it, reimplement it, or
  style it outside `xtermTheme()`.
- **Do not force `.xterm-screen`'s height.** In xterm 6 the screen sits inside
  `.xterm-scrollable-element`; forcing 100% collapses that wrapper — and the
  scrollbar — to zero height.
- **Scrollbar rules must name the element that actually SCROLLS, and a scroll box
  whose CONTENT HEIGHT CHANGES reserves its gutter** (`scrollbar-gutter: stable`
  — `.tree-scroll`, `.rail-list`). Three are deliberately left alone, so don't
  re-file them: `.pane-menu`, `.media-body` and `.crash-msg` get their content
  once and cannot toggle a bar (and `.media-body` centres its child, so a
  one-sided gutter would off-centre the image). `.cm-scroller` is the
  interesting one — it already has a themed `::-webkit-scrollbar`, which makes
  its bar classic on EVERY platform, so a gutter there costs 8px of editor width
  everywhere to prevent a flicker CodeMirror's measure loop already damps. The tree's rules
  were written against `.file-tree`, which is the inner list — `.tree-scroll` is
  the scroll box — so the tree drew the platform default. That is invisible on
  macOS (overlay scrollbars, zero layout width) and a fat classic bar on Windows
  that takes REAL width: expanding a folder toggled it, which reflowed every
  `nowrap` row, which toggled the horizontal bar, which changed the height again.
  The panel flickered on every click, on Windows only. Reserve the gutter and the
  appearance of a scrollbar reflows nothing.
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

## Diagnostics (`src-tauri/src/diag.rs`, `src/lib/diag.ts`)

The app sends nothing anywhere, and an installed copy has no console, no stderr
and no devtools — so without this file a crash report is the words "it crashed".

- **Three markers, and only the third means the user saw anything.** `[launch]`
  (before any UI exists) → `[ready]` (Tauri created the window and webview) →
  `[painted]` (the webview composited a frame, `logPainted` in `diag.ts`). A
  Fedora white window logged `[launch]` AND `[ready]` and then its WebKit web
  process aborted, so anything asserting on `[ready]` calls that a clean start —
  `linux-smoke.yml` did, and reported "the AppImage now works on Fedora" on the
  very run whose log says `EGL_BAD_PARAMETER. Aborting...`. `[ready]` with no
  `[painted]` IS the white-window signature; assert on `[painted]`.
- **`diag::init()` is the first line of `run()`, before GTK/WebKit/WebView2
  exist; `diag::ready()` is the first line of `setup()`.** Tauri creates the
  config windows BEFORE calling setup, so `[launch]` without `[ready]` in the
  log means the window/webview never came up — the Linux blank-window family
  and a Mac launch kill both land there. That is why the log dir is resolved
  with `dirs` (already Tauri's own dependency) and not through an `AppHandle`.
  The panic hook is process-global, so it covers the pty threads, the watcher
  and the async runtime — from the moment it is installed, and nothing may be
  installed above it.
- **Nothing in `diag.rs` may panic** — it runs inside the panic hook. No
  `unwrap`/`expect`; every I/O error is dropped. Same contract for `logEvent` in
  `diag.ts`: it is called from `componentDidCatch` and the global error handlers,
  so it must never throw or reject back into them.
- **The log is local-only, by design.** The app watches people's source trees; a
  reporter that phones home is an opt-in feature, not a default. The file lives
  in `app_log_dir()` (macOS `~/Library/Logs/<id>/`, Windows
  `%LOCALAPPDATA%\<id>\logs\`, Linux `~/.local/share/<id>/logs/`); Settings →
  Diagnostics shows the path and reveals it. `linux-smoke.yml` asserts on the
  `[launch]` / `[ready]` / `[PANIC]` tags, so those strings are an interface.
- **It cannot see a crash below Rust** (WebKit/WebView2, a stack overflow,
  Gatekeeper). Those live only in the OS crash reporter — Console.app → Crash
  Reports, Reliability Monitor. A `[launch]` line with nothing after it, at the
  time of the report, is the tell.

## Subprocesses on Windows (`git.rs`)

- **Every console program we spawn needs `CREATE_NO_WINDOW`.** `main.rs` builds a
  GUI-subsystem binary, so the process owns no console and Windows allocates a
  fresh one per spawn — a black box that flashes and steals focus. `git status`
  runs on every filesystem event the watcher reports, so an agent editing files
  made the screen strobe. The flag lives in `git()`, which is why every git call
  must keep going through it. (`lsof` is `#[cfg(unix)]`; `explorer`/`open`/
  `xdg-open` are GUI launchers and need nothing.)

## Shared state must survive a panic

- **Never `.lock().unwrap()` on state the UI depends on** — use
  `unwrap_or_else(|e| e.into_inner())` (`sessions()` in `pty.rs`, the two sites in
  `watcher.rs`). A `Mutex` stays poisoned forever once any thread panicked while
  holding it, so a plain unwrap turns one bug into a dead window: the next
  `pty_write` — sync, on the IPC thread — panics, taking every OTHER session's
  shell with it. These maps hold owned values mutated by single
  `insert`/`remove` calls, so a panic leaves them stale, never torn. Nothing is
  swallowed: the panic is already in the crash log with its backtrace.

## Backend command threading

- **Anything that shells out, touches disk, or scans the process table is
  `#[tauri::command(async)]`.** A plain `#[tauri::command]` runs INLINE on the
  IPC/main thread and is felt as a frozen window.
- **`async` is not a parking spot either.** On a *sync* fn it generates
  `async_runtime::spawn`, NOT `spawn_blocking` (tauri-macros `command/wrapper.rs`
  → `ipc/mod.rs::respond_async_serialized`), so the body runs on a tokio WORKER
  thread and that pool is only `num_cpus` wide. Work that can block for an
  unbounded time belongs on a thread of its own — see `reap_detached` in `pty.rs`.
- **The deliberate sync exceptions, every one pure or enqueue-only.** Don't count
  them in prose — a number here has already gone stale once; check the code.
  - `get_root` / `home_dir` — pure env lookups; the IPC hop costs more than the work.
  - `diag_info` — a pure version/path lookup.
  - `play_sound`, `set_watch_root`, `pty_cd`, `pty_insert_paths` — one channel
    send each. `pty_resize` — one non-blocking ioctl.
  - `pty_write` — enqueues to the session's writer thread (see PTY above).
  - `pty_spawn` and `pty_kill` — sync for ORDERING, and it is load-bearing. Sync
    commands serialize on the IPC thread, which is the only thing that makes
    `pty_spawn`'s owner check, its `take_and_reap` and its `insert` — three
    separate lock acquisitions — a safe check-then-act. Move it to the async pool
    and two same-id spawns can both pass the owner check before either reaps; the
    second insert then overwrites and drops the first handle, whose reader thread
    fails the token guard and never reaps it. That is the ⌘N "lost Claude Code"
    regression's exact shape, which a release already paid for; converting it
    means claiming the id atomically under ONE guard first. The same
    serialization guarantees a `pty_kill(id)` issued before a `pty_spawn(id)`
    (HMR remount, ErrorBoundary "Try again") cannot land after it and kill the
    fresh shell. Neither blocks: the kill+wait is detached.

## Linux (`src-tauri/src/lib.rs`, `src-tauri/src/fs.rs`)

Linux fails *silently* — no crash, no log line, just a window that never fills in.
Both rules below are the fixes for exactly that.

- **Set `WEBKIT_DISABLE_DMABUF_RENDERER=1` before `Builder::run`.** WebKitGTK
  2.42+ defaults to a DMA-BUF backing store and, where it can't negotiate one,
  emits no frames at all — the window opens, the web process lives, the content
  area stays grey forever. Our AppImage guarantees the mismatch: it bundles
  Ubuntu 22.04's GTK + WebKit but *not* libEGL/libgbm/libdrm, so an old WebKit
  negotiates with the host's driver. Only set when unset, so a user can hand the
  path back. It must run before GTK initialises, not in `setup()`.
- **An AppImage's cwd is the app's own read-only mount, never a project.** Its
  AppRun chdirs into `$APPDIR/usr` because the bundled libwebkit2gtk is
  byte-patched `/usr` → `././` (same length, patches in place) and only resolves
  its helper processes from there. So `project_root` answers the AppImage case
  FIRST, from `OWD` (the runtime records the real launch dir) then `HOME` —
  otherwise the file browser opens on `/tmp/.mount_XXXXXX/usr` and `git_status`
  runs there. Pinned by `appimage_launch_never_roots_on_the_mount`.
- **The `.deb`/`.rpm` use the *system* WebKitGTK; only the AppImage bundles its
  own.** When a Linux user reports a blank window, the first question is which
  artifact — they are different failure surfaces.
- **The AppImage's bundled WebKit cannot start against a modern Mesa, so the
  distro package is the answer on Linux, not the AppImage.** On Fedora 44
  (Mesa 26) the bundled Ubuntu-22.04-era WebKitGTK aborts inside its OWN EGL
  init — `Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...`,
  string proven to live in the bundled `libwebkit2gtk-4.1.so.0` — and
  WebKitWebProcess dies on SIGABRT, leaving a WHITE window (not the grey one the
  DMABUF flag fixes; white means the page never rendered at all). The host's EGL
  is healthy; only the bundle fails. NO environment variable helps — DMABUF,
  compositing, llvmpipe, `GDK_BACKEND`, sandbox and `EGL_PLATFORM` were all tried
  — because the bundle is an internally consistent OLD set: swapping just WebKit
  cascades into GStreamer (`gst_pad_probe_info_set_buffer`) and then GLib
  (`g_once_init_leave_pointer`). Running the same binary against the pure Fedora
  system stack works, and all 166 of its direct deps resolve there, which is why
  the `.rpm`/`.deb` are fine. The `fedora` job in `linux-smoke.yml` gates on the
  rpm and probes the AppImage, so we learn the day a newer bundled WebKit fixes
  it; until then `site/terminal/index.html` leads with `.deb`/`.rpm`.
- **The AppImage needs the host's Mesa** — `libegl1`, `libgl1`, `libgbm1` are
  exactly what the bundle omits so it can negotiate with the host's driver.
  Without libEGL the binary does not even load (`libEGL.so.1: cannot open shared
  object file`) — a "does nothing" on a minimal install or an old WSL. Every
  desktop has them; `linux-smoke.yml` installs them to stand in for one, and the
  download page names the fix.

## Paths (`src/lib/paths.ts`)

- **`PATH_RE` must keep a path's leading separator.** A segment loop that can
  only start at a word character matches `Users/me/a.ts` inside `/Users/me/a.ts`,
  so every clicked ABSOLUTE path came back RELATIVE and was re-rooted under the
  session cwd. The root alternative (`[A-Za-z]:[\\/]` or `[\\/]{1,2}`, the
  second for a UNC `\\host\share`) is the only thing holding that. Pinned by
  the absolute / UNC cases in `paths.test.ts`.
- **Every path helper is separator-agnostic.** The backend hands us *native*
  paths, so Windows paths arrive with backslashes. A POSIX-only `split("/")`
  silently returns the whole path as a basename, an empty dirname (new files land
  at the drive root), and never matches an ancestor. Helpers that must agree with
  each other should compose (`isDirectChild` goes through `dirname`), not
  re-normalize by hand.

## Download page (`site/terminal/index.html`, `release.yml`)

- **Every card links a stable-named asset; the GitHub API is an upgrade, never a
  dependency.** `releases/latest/download/<stable name>` always resolves to the
  newest release, so the page works with no JavaScript at all. The API path went
  dead in a room full of people: the unauthenticated limit is 60 requests/hour
  **per IP**, everyone behind one Wi-Fi shares an IP, and a 403 is a valid JSON
  body with no `assets` — the old script handled it as a release with nothing in
  it and disabled every card. `r.ok` is checked; a failed lookup changes nothing.
- **The stable names are shared between `release.yml` and the page.** Rename one
  in both, in the same commit, and never before the release that carries the
  new name exists.
- **The Linux AppImage needs glibc ≥ 2.35** (it is built on Ubuntu 22.04) and the
  executable bit the browser strips. The page says both; the `.deb` (system
  WebKit) is the safer choice on Ubuntu/Debian. `linux-smoke.yml` is the only
  Linux desktop the team has — run it against every release.

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
