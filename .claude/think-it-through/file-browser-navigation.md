# File-browser folder navigation + terminal `cd` sync

_Status: decided — ready to implement. Medium-sized change (frontend-only)._

## Intention

Make the file browser a place you can **walk into and out of folders**, with the
terminal's working directory following along — go into a folder and the shell
`cd`s in; go up and it `cd`s out. Keep the existing expand/collapse tree; this
adds navigation on top of it, it doesn't replace it. Bundled with this is a
**Windows bug fix**: the current "cd into folder" emits Mac-style quoting that
`cmd.exe` rejects.

## How it is now (verified in code)

- **The browser already follows the terminal.** `App.tsx:332` feeds the active
  terminal's cwd (`terminalCwd`) into `SidePanel`'s `root`, and `FileTree` re-lists
  whenever `root` changes (`FileTree.tsx:26`). So "terminal → browser" sync already
  works: type `cd` in the shell and the tree re-roots. The file **watcher** also
  re-roots to the new cwd (`App.tsx:332` → `setWatchRoot`).
- **The tree is an inline accordion.** `FileTree`/`TreeNode` — single-click a folder
  expands/collapses it in place (`FileTree.tsx:101` `activate`). This is the
  "expanded view" the user wants to keep.
- **The only "browser → terminal" control is a right-click.** `SidePanel.tsx:194`
  "Open in terminal" → `App.tsx onOpenInTerminal` (`App.tsx:228`) →
  `pty_write("cd " + shellQuote(dir) + "\n")`. **There is no "up"/back at all.**
- **Quoting is POSIX-only.** `shellQuote` (`App.tsx:35`) wraps in **single quotes**:
  `'C:\folder'`. Used in **three** places: the cd-into-folder, **drag-drop** of files
  onto the window (`App.tsx:315`), and the **first-run** folder pick (`App.tsx:590`).
- **Default Windows shell is `cmd.exe`.** `pty.rs:60 default_shell()` returns
  `COMSPEC` (cmd.exe) on Windows, falling back to `powershell.exe`. App passes
  `shell: null` (`TerminalPane.tsx:371`), so the default is what runs. There is **no
  user shell setting**.

## The real problem (one sentence)

You can't navigate folders from the browser (no "go up", clumsy "go in"), and the
one control that exists is broken on Windows because it sends `cd 'C:\path'` in
Mac-style single quotes that `cmd.exe` reads literally and rejects.

## Who feels it

The Windows user (the friend) — every path-to-shell action fails for them:
cd-into-folder, drag-drop a file/screenshot, and the first-run `cd`. Everyone
feels the missing navigation, Mac included.

## The Windows quoting fix (resolved — low risk)

Make `shellQuote` platform-aware:

- **Mac/Linux:** keep POSIX single-quoting (safe against `$`, backticks, etc.).
- **Windows:** wrap in **double quotes** — `cd "C:\folder"`. This works in **both
  cmd.exe and PowerShell** (the only realistic default shells), so we don't need to
  detect which shell is running. Windows filenames legally cannot contain `"`, so
  there is nothing to escape. Deliberately **no `cd /d`**: `/d` is cmd-only and
  breaks PowerShell, and cross-drive navigation isn't reachable through this
  cwd-rooted UI anyway (you only ever move within the current drive's tree).

Detect Windows in the frontend via `navigator.userAgent` (WebView2 → "Windows NT")
— no new Tauri plugin/dependency needed. This one change fixes cd-into-folder,
drag-drop, and first-run together.

## Proposed navigation (the full set — user chose "all")

Everything below drives the terminal by sending a `cd` (the shell owns its cwd;
there is no other way to move it), then the existing terminal→browser sync
re-roots the tree. So all of it rides on the quoting fix above.

1. **Clickable breadcrumb path** at the top of the Files section — each segment
   `cd`s up to that level. Doubles as "where am I". Handles both `/` and `\`
   separators.
2. **`..` row at the top of the tree** — `cd ..` (up one level), right where your
   eyes are in the list.
3. **Double-click a folder → `cd` into it.** Single-click still expands/collapses
   inline (unchanged). Keep the existing right-click "Open in terminal" too.
4. **Back / Forward** buttons — browser-style history of visited folders.

_No standalone "Up" button:_ the breadcrumb's parent segment + the `..` row already
cover "up", so a third up-control would just clutter the narrow panel.

## Risks / edge cases

- **Back/Forward history is the complex piece.** Model: keep a per-session stack of
  visited cwds + a pointer (mirrors the existing per-session `paneMemory` pattern in
  `SidePanel.tsx:101`). Any cwd change that isn't a back/forward action pushes a new
  entry (so manual `cd` in the terminal is captured too, truncating the forward
  tail); Back/Forward move the pointer and send a `cd` **guarded** so the resulting
  cwd change does NOT push a new entry (else it loops). Switching tabs shows that
  session's own history.
- **Double-click vs single-click:** the two single-clicks preceding a double-click
  toggle the folder open→closed. Handle so a double-click leaves the folder in a
  sensible state and `cd`s in; acceptable minor jank, no correctness issue.
- **Navigating above the project** (breadcrumb to home/`/` or `C:\`): the watcher
  refuses broad roots (by design, `watcher.rs`), so live-diff refresh pauses there,
  but listing still works. Acceptable.
- **cd sent onto a non-empty prompt** appends to whatever's typed — pre-existing
  behavior of the current right-click; not changed here.

## Alternatives considered

- **Do nothing / only fix the bug:** fixes Windows but leaves navigation clumsy.
  Rejected — user explicitly wants in/out navigation.
- **Single-level Explorer-style browser (replace the tree):** loses the expand
  tree the user wants to keep. Rejected.
- **Detect cmd vs PowerShell vs bash and quote per-shell:** unnecessary — a
  double-quoted path already satisfies cmd + PowerShell; bash-on-Windows is a
  power-user setup outside the default. Rejected as over-engineering.

## Files this will touch (frontend only)

- `src/App.tsx` — platform-aware `shellQuote`; likely lift cwd-navigation helpers
  (cd-to-path) so SidePanel can call them.
- `src/components/SidePanel.tsx` — breadcrumb, back/forward, per-session history,
  wire "cd into"/"cd up" callbacks.
- `src/components/FileTree.tsx` — `..` row, double-click-to-enter.
- `src/App.css` — breadcrumb + nav-button styling.
- Possibly `src/lib/paths.ts` — breadcrumb segment splitting (both separators).

No Rust changes required.

## Decision

**Go.** Ship the Windows quoting fix + the full navigation set (breadcrumb, `..`,
double-click-to-enter, back/forward). Frontend-only, medium size.
