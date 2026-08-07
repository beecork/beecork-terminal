// Pure path / terminal-output parsing helpers — extracted here so they can be
// unit-tested and shared instead of living inline in components.

/** Decode base64 (PTY output over the Tauri Channel) to raw bytes. */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// Every path helper below is separator-agnostic: the backend hands us NATIVE
// paths, which means backslashes on Windows. A POSIX-only `split("/")` there
// doesn't just look wrong — it silently returns the whole path as a "basename",
// an empty `dirname` (so a new file lands at the drive root), and never matches
// a directory ancestor (so changed folders never colour). Treat `/` and `\` as
// equivalent separators everywhere, and emit the one the input already uses.

/** A drive-rooted Windows path prefix, e.g. the `C:` of `C:\Users`. */
const DRIVE_RE = /^[A-Za-z]:/;
/** One or more trailing separators, of either flavour. */
const TRAILING_SEP_RE = /[\\/]+$/;

/** Index of the last separator of either flavour, or -1. */
function lastSep(p: string): number {
  return Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
}

/** Does this path use Windows conventions (a drive letter, or backslashes and
 *  no POSIX-absolute lead)? Decides which separator we *emit* when joining. */
function isWindowsStyle(p: string): boolean {
  return DRIVE_RE.test(p) || (p.includes("\\") && !p.startsWith("/"));
}

/** Absolute on either platform: POSIX `/a`, Windows `C:\a`, or a UNC `\\host`. */
export function isAbsolute(p: string): boolean {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** Last path segment, tolerant of trailing separators ("/a/b/" → "b", "/" → "/",
 *  "C:\a\b" → "b", "C:\" → "C:"). */
export function basename(p: string): string {
  const trimmed = p.replace(TRAILING_SEP_RE, "");
  if (trimmed === "") return p === "" ? "" : "/"; // "/" (or "///") is its own name
  const idx = lastSep(trimmed);
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Parent directory ("/a/b/c" → "/a/b", "/a" → "/", "a" → "", "C:\a" → "C:\"). */
export function dirname(p: string): string {
  const trimmed = p.replace(TRAILING_SEP_RE, "");
  const idx = lastSep(trimmed);
  if (idx < 0) return "";
  if (idx === 0) return "/"; // "/a" → the POSIX root
  const head = trimmed.slice(0, idx);
  // "C:\a" → "C:\", not the bare drive "C:" (which means "cwd on C:").
  return DRIVE_RE.test(head) && head.length === 2 ? head + "\\" : head;
}

/** Join a directory and a name with exactly one separator, matching the
 *  directory's own flavour so a Windows path stays a Windows path. */
export function joinPath(dir: string, name: string): string {
  const sep = isWindowsStyle(dir) ? "\\" : "/";
  return dir.replace(TRAILING_SEP_RE, "") + sep + name.replace(/^[\\/]+/, "");
}

/** Split an absolute path into breadcrumb segments, each carrying the absolute
 *  path up to and including it. Cross-platform: understands POSIX (`/a/b`) and
 *  Windows (`C:\a\b`) separators, because the backend hands us native paths —
 *  backslashes on Windows. The first crumb is the filesystem / drive root. Pure,
 *  so it's unit-tested. */
export function breadcrumbs(path: string): { name: string; path: string }[] {
  if (!path) return [];
  const winDrive = /^[A-Za-z]:/.exec(path);
  // Windows-style when it starts with a drive (C:) or uses backslashes and isn't
  // a POSIX absolute path.
  if (winDrive || (path.includes("\\") && !path.startsWith("/"))) {
    const drive = winDrive ? winDrive[0] : "";
    const rest = path.slice(drive.length).replace(/^[\\/]+/, "");
    const out = [{ name: drive || "\\", path: drive + "\\" }];
    let acc = drive;
    for (const seg of rest.split(/[\\/]+/).filter(Boolean)) {
      acc += "\\" + seg;
      out.push({ name: seg, path: acc });
    }
    return out;
  }
  const out = [{ name: "/", path: "/" }];
  let acc = "";
  for (const seg of path.split("/").filter(Boolean)) {
    acc += "/" + seg;
    out.push({ name: seg, path: acc });
  }
  return out;
}

/** The parent directory of an absolute path, cross-platform (POSIX + Windows).
 *  Returns the path unchanged when it is already a filesystem / drive root, so
 *  callers can detect "can't go up" via `parentDir(p) === p`. */
export function parentDir(path: string): string {
  const cr = breadcrumbs(path);
  return cr.length >= 2 ? cr[cr.length - 2].path : cr[0]?.path ?? path;
}

/** Is `path` an entry sitting DIRECTLY inside `dir` (not deeper)? Used to decide
 *  whether a filesystem event can change a directory's listing at all.
 *
 *  Both sides go through `dirname` so the drive-root special case (`"C:\a"` →
 *  `"C:\"`, not the bare `"C:"`) applies identically to each. Normalizing `dir`
 *  by hand instead made the two disagree at exactly that root, so browsing at a
 *  Windows drive root never refreshed the tree. */
export function isDirectChild(path: string, dir: string): boolean {
  if (!dir) return false;
  return dirname(path) === dirname(joinPath(dir, "x"));
}

/** Path relative to `root` ("/r/a/b" under "/r" → "a/b"); returns it unchanged if
 *  outside root. The separator check is what keeps "/repoX/a" from reading as
 *  being inside "/repo". */
export function relativePath(full: string, root: string): string {
  if (!root) return full;
  const r = root.replace(TRAILING_SEP_RE, "");
  if (full === r || full === root) return basename(full);
  if (!full.startsWith(r)) return full;
  const rest = full.slice(r.length);
  return /^[\\/]/.test(rest) ? rest.replace(/^[\\/]+/, "") : full;
}

/** Matches file-ish tokens (optionally with :line[:col]) in terminal output,
 *  POSIX or Windows — an optional drive prefix, then segments separated by
 *  either slash. The drive's own colon can't be mistaken for the `:line`
 *  suffix, since that suffix is only recognised at the very end of the token. */
export const PATH_RE =
  /(?:[A-Za-z]:[\\/])?(?:[\w.@~-]+[\\/])*[\w.@~-]+\.[A-Za-z]{1,10}(?::\d+(?::\d+)?)?/g;

/** Matches http(s) URLs (incl. localhost) in terminal output, up to whitespace/
 *  quotes/brackets. The final char excludes trailing sentence punctuation so
 *  "visit http://localhost:3000." links to the URL without the period. */
export const URL_RE = /https?:\/\/[^\s'"()<>[\]]*[^\s'"()<>[\].,;:!?]/g;

/** True for a localhost / loopback URL (candidate for the in-app preview vs system browser). */
export function isLocalUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(url);
}

const CODE_EXT =
  /\.(ts|tsx|js|jsx|mjs|cjs|json|rs|py|css|scss|less|html|md|txt|go|java|c|cc|cpp|h|hpp|toml|yml|yaml|sh|lock|rb|php|swift|kt|sql|vue|svelte)$/i;

/** True when a matched token looks like a path worth making clickable. */
export function looksLikePath(token: string): boolean {
  const noPos = token.replace(/:\d+(?::\d+)?$/, "");
  return token.includes("/") || token.includes("\\") || CODE_EXT.test(noPos);
}

/** Split a "file:line[:col]" token into its file and 1-based line (col ignored). */
export function splitFileLine(token: string): { file: string; line?: number } {
  const pos = token.match(/:(\d+)(?::\d+)?$/);
  if (pos && pos.index !== undefined) {
    return { file: token.slice(0, pos.index), line: parseInt(pos[1], 10) };
  }
  return { file: token };
}

/** Parse an OSC 7 payload (`file://<host>/<abs-path>`, percent-encoded) → path. */
export function parseOsc7(data: string): string | null {
  const m = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

export type MediaKind = "image" | "video" | "audio";

const MEDIA_EXT: Record<string, MediaKind> = {
  // NB: svg is intentionally excluded — it's hand-edited XML, so it opens in the
  // text editor (editable + diffable), not the read-only image preview.
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image",
  bmp: "image", ico: "image", avif: "image", apng: "image",
  mp4: "video", webm: "video", mov: "video", m4v: "video", ogv: "video", mkv: "video",
  mp3: "audio", wav: "audio", ogg: "audio", m4a: "audio", aac: "audio", flac: "audio", opus: "audio",
};

/** Media type the viewer can render inline (via the asset protocol), or null for text/other. */
export function mediaKind(path: string): MediaKind | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return MEDIA_EXT[ext] ?? null;
}

/**
 * Every ancestor directory (up to and including `root`) of the given changed
 * file paths — used to color changed folders in the tree. Walks up with the
 * cross-platform `parentDir`, so it works on Windows paths too.
 */
export function changedAncestors(paths: string[], root: string): Set<string> {
  const set = new Set<string>();
  if (!root) return set;
  const r = root.replace(TRAILING_SEP_RE, "") || root;
  for (const full of paths) {
    let p = dirname(full);
    while (p && p.length >= r.length) {
      set.add(p);
      if (p === r) break;
      const up = parentDir(p);
      if (up === p) break; // reached a filesystem / drive root
      p = up;
    }
  }
  return set;
}
