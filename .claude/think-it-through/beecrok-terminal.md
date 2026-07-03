# Beecork Terminal — a CLI-agent cockpit

> Status: **DECIDED.** Fresh build on **Tauri**. This brief captures the reasoning and the decision; it's ready to become an implementation plan.

## Intention

Build a desktop app whose main window is a real terminal running a CLI coding agent (Claude Code, Codex, or any CLI). Around that terminal:
- a **live diff view** that shows, with color, which folders and files changed and exactly which lines changed as the agent works;
- an **expandable right-side panel** that is a file browser for the current folder — navigate, view, and edit files.

The **terminal is the star**; the diff and file browser are the supporting cast. Working name: *Beecork Terminal*. It is a **Beecork product** (may be shipped/sold), not just a personal tool.

## Confirmed goals (from the user)

- **Terminal is the star** — the agent is the full-size main experience, editor/browser are the sidekick.
- **Lean & fast** — stated twice; a real priority and part of the product's identity.
- **Tailored layout** — this exact arrangement of terminal + live diff + file panel.
- **It's a product** — Beecork-branded, cross-platform.
- **Platforms:** **Mac first, then Linux, then Windows.**
- **Quality bar:** willing to go slowly to get the best, final result — not chasing a quick throwaway.
- **Fresh build** — explicitly NOT based on any existing app (see CozyPane note below).

## The three real pieces (so we build the right thing)

This app is three loosely-coupled parts. Seeing them clearly drove the stack choice:

1. **The terminal** — hosts a real interactive process (Claude Code is a full-screen TUI). Needs a **PTY** (pseudo-terminal — the OS plumbing that lets a GUI app run a real shell/CLI) + a renderer that handles ANSI colors, cursor moves, and alternate-screen TUIs.
2. **The live diff view** — watches the folder and, whenever files change, computes a diff (against git HEAD or a session snapshot) and renders it with color at three levels: folder, file, line. **It watches the *filesystem*, so it's agent-agnostic** — works for Claude Code, Codex, or a human, by construction.
3. **The file browser / editor panel** — a tree of the current folder + view/edit of individual files.

Parts 2 and 3 are ordinary rich-UI work. Part 1 is the only "special" part — and even it is a solved problem.

## Key realization that shaped everything

**Terminal *rendering speed* is not this app's bottleneck.** Claude Code streams text; it's not a 120fps game. A web terminal renderer (**xterm.js** — the exact component VS Code's terminal uses) renders its TUI perfectly, and its **WebGL addon** GPU-accelerates it. So "go native for terminal speed" optimizes a non-problem. The genuinely hard, valuable part is the **editor + diff view**, which is *dramatically* easier with a mature web component (**Monaco**) than hand-built in any native toolkit.

That reframed the whole decision: optimize for **building the rich UI well and keeping the app lean**, not for shaving terminal-render microseconds nobody feels.

## Why NOT full-native (Rust+GPUI / Zig)

The user pushed hard on native ("why not slowly, but best quality?"). Honest answer — native is the wrong optimization *for this product*:

- Your app is **terminal + code editor + diff view.** In native land the terminal is the *bounded, solved* part, but the **editor is a monster**: a syntax-highlighting code editor (Monaco) is person-decades of work, and native GUI toolkits hand you *none* of it. You'd rebuild Monaco in Rust, and it'd be **worse than Monaco for years.**
- So native = a great terminal wrapped around a *worse* editor & diff view, for **5–10× the effort.** "Slowly but best" in native paradoxically yields a **lower-quality** editor — which is half the app.
- Apple certification is also hardest for native (hand-scripted `codesign` + `notarytool` + entitlements) vs. one automated config line for the web stacks.

**Native: ruled out.**

## The real decision: Tauri vs Electron (both ship the same web UI)

Both run an *identical* frontend — same xterm.js(+WebGL) terminal, same Monaco editor/diff, same React panels. So every "tailored UI" feature is equally easy in both. The differences are entirely in the **shell around** the UI.

### Full pros & cons (scored against our needs)

| Our need | Electron | Tauri |
|---|---|---|
| Terminal works well (the star) | ✅ proven, zero-effort (node-pty) | ✅ great; you own the PTY bridge (portable-pty) |
| **Lean & fast** *(stated twice)* | ⚠️ heavy (~150–250MB RAM, ~90MB install) | ✅✅ light (~3–15MB install, fast boot) |
| Tailored diff/panel/editor UI | ✅ | ✅ *(identical web UI)* |
| **Cross-platform consistency** | ✅✅ ships own Chromium → identical everywhere | ⚠️ 3 engines (WebKit/WebView2/**WebKitGTK**); Linux weak |
| Apple certification | ✅✅ turnkey (electron-builder), proven on user's acct | ✅ nearly as easy (built-in sign+notarize) |
| Auto-update (it's a product) | ✅✅ electron-updater | ✅ built-in signed updater |
| Security (runs commands) | ⚠️ footguns (contextIsolation etc.) | ✅ safer by default (Rust + capability allow-list) |
| Build effort (fresh, from zero) | ✅ easiest (Node ecosystem) | ⚠️ Rust backend + PTY bridge |
| Ecosystem / longevity | ✅✅ huge, mature, 10+ yrs | ⚠️ younger (v2), growing fast |
| Premium lean "feel" | ⚠️ 200MB blob | ✅ crafted, native-feeling |
| Distribution robustness | ⚠️ native-node-module rebuilds | ✅ PTY compiles into the Rust binary |

**Pattern:** Electron wins **proven / consistent / easy**. Tauri wins **lean / fast / secure / premium-feel**. Strong on opposite axes.

### Tauri's one real risk — and why it's acceptable here

Tauri uses each OS's *own* webview (WebKit on Mac, Chromium-based WebView2 on Windows, **WebKitGTK on Linux — the weak, quirky one**). Three engines = more cross-platform QA, Linux most of all. **But the Mac-first rollout defers this risk**: build and prove on Mac (solid WebKit), then Windows (Chromium-based, usually smooth), and face Linux last — by which point the app is mature. The Rust backend (PTY bridge, file watcher, git) is more effort than Node, but it's largely absorbed because the assistant writes it, and it buys leanness, security, and clean distribution.

### Decision

**➡️ Tauri.** It matches the stated values best — lean & fast, premium product feel, terminal-as-star (via xterm.js+WebGL), with the genuinely-hard editor/diff kept in the easy, free web layer (Monaco). Mac-first rollout defers its only real weakness. Electron remains the honest fallback if the Rust backend or Linux webview ever becomes a blocker — the entire frontend ports over unchanged.

## Proposed stack (concrete)

- **Shell:** Tauri v2 (Rust core).
- **Frontend:** React + TypeScript + Vite.
- **Terminal:** xterm.js + `@xterm/addon-webgl` (GPU) + `@xterm/addon-fit`.
- **PTY:** Rust `portable-pty` (from wezterm), streamed to the webview via a Tauri v2 `Channel`.
- **Editor + diff:** **CodeMirror 6** (`@uiw/react-codemirror` + `@codemirror/merge` for the line diff). *Decision made: chose CodeMirror over Monaco for leanness — it uses no web workers, keeping the Tauri bundle small, which serves the "lean & fast" value.*
- **File watching:** Rust `notify`. **Git/diff:** `git2` or `git` CLI. **Filesystem:** Rust std + Tauri fs.
- **Packaging/cert:** Tauri bundler → macOS (dmg, arm64+x64) sign+notarize first; Windows (nsis/msi) + Linux (AppImage/deb) later.
- **Auto-update:** Tauri updater plugin (signed).

## Smallest first milestone (Occam's razor)

The minimum that delivers the described feeling, on Mac:
1. A window with a working terminal running `claude` (or any command) — PTY bridge solid, resize + colors correct.
2. A right-side collapsible panel = file tree of the folder + click-to-view a file.
3. A diff view that colors changed folders/files/lines by watching the folder against git.

Editing in the panel, multiple tabs/terminals, themes, Windows/Linux builds, auto-update — all come after this proves out on Mac.

## Note on CozyPane (why it's not the base)

During this exercise we found an existing certified app, **CozyPane** (`/Users/apple/Coding/cozy/zzterminal/cozypane`), that is architecturally almost identical (Electron + xterm.js + node-pty + Monaco + colored file tree + diff viewer + notarized). The user **explicitly chose a fresh build, not based on it.** CozyPane therefore serves only as: (a) **proof** the terminal+editor+notarization pattern works on the user's Apple account, and (b) a **reference** to peek at if a specific problem arises (e.g. terminal entitlements, PTY handling, diff-watcher design) — its Mac entitlements were `allow-jit`, `allow-unsigned-executable-memory`, `disable-library-validation`, useful to know a JIT/terminal app needs these. Not a base, not to be copied.

## Open sub-decisions for the planning stage

- **Editor:** ~~Monaco vs CodeMirror~~ — **RESOLVED: CodeMirror 6** (lighter, no web workers). Shipped.
- **Diff baseline for non-git folders:** git HEAD vs a snapshot taken when the session starts.
- **How much of Claude Code's UX to wrap** vs. just hosting the raw terminal (v1: just host it).

## Decision & next step

**Decided:** fresh build, **Tauri** stack as specified above, Mac-first. Native and Electron considered and set aside (with Electron kept as a documented fallback).

**Next step:** turn this brief into a step-by-step implementation plan — start with the Mac terminal spike (Tauri + xterm.js + portable-pty PTY bridge) to de-risk the one non-trivial part before building the diff/file-browser UI on top.
