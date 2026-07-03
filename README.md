# Beecork Terminal

A desktop cockpit for CLI coding agents. A full terminal running Claude Code
(or any CLI agent), with a **live git-aware diff view** and a **file
browser/editor** side by side — so you can watch what the agent changes as it
works.

Built with [Tauri](https://tauri.app) (Rust core) + React/TypeScript, so it's a
small, fast, native app for macOS, Windows, and Linux.

## Features

- **Terminal-first** — a real GPU-rendered terminal (xterm.js + a Rust
  `portable-pty` backend) running your login shell.
- **Live diff view** — the file tree colors changed folders/files, and each
  file shows a line-level diff against git as the agent edits.
- **File browser + editor** — expandable side panel; open, edit (CodeMirror),
  and split into two views.
- **Sessions** — a left rail of terminal sessions that keep running in the
  background; rename, pin, `⌘T` for a new one.
- **Clickable & searchable** — click a `file:line` in output to open it; `⌘F`
  to search scrollback.
- **Themeable** — multiple color themes, adjustable font. Self-updates from
  GitHub Releases.

## Download

Grab an installer from [**beecork.com/terminal**](https://beecork.com/terminal)
or the [releases page](https://github.com/beecork/beecork-terminal/releases/latest).

## Development

```bash
npm install
npm run tauri dev            # run the app
npm test                     # frontend unit tests
cd src-tauri && cargo test   # Rust unit tests
```

Releasing is automated — see [RELEASING.md](./RELEASING.md).

## License

© Beecork.
