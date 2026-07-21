// Pure path / terminal-output parsing helpers — extracted here so they can be
// unit-tested and shared instead of living inline in components.

/** Decode base64 (PTY output over the Tauri Channel) to raw bytes. */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** Last path segment, tolerant of trailing slashes ("/a/b/" → "b", "/" → "/"). */
export function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Parent directory ("/a/b/c" → "/a/b", "/a" → "/", "a" → ""). */
export function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return "";
  return idx === 0 ? "/" : trimmed.slice(0, idx);
}

/** Join a directory and a name with exactly one separator. */
export function joinPath(dir: string, name: string): string {
  return dir.replace(/\/+$/, "") + "/" + name.replace(/^\/+/, "");
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

/** Path relative to `root` ("/r/a/b" under "/r" → "a/b"); returns it unchanged if outside root. */
export function relativePath(full: string, root: string): string {
  if (!root) return full;
  const r = root.replace(/\/+$/, "");
  if (full === r) return basename(full);
  return full.startsWith(r + "/") ? full.slice(r.length + 1) : full;
}

/** Matches file-ish tokens (optionally with :line[:col]) in terminal output. */
export const PATH_RE =
  /(?:[\w.@~-]+\/)*[\w.@~-]+\.[A-Za-z]{1,10}(?::\d+(?::\d+)?)?/g;

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
  return token.includes("/") || CODE_EXT.test(noPos);
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
 * file paths — used to color changed folders in the tree.
 */
export function changedAncestors(paths: string[], root: string): Set<string> {
  const set = new Set<string>();
  if (!root) return set;
  for (const full of paths) {
    let p = full;
    const slash = p.lastIndexOf("/");
    p = slash > 0 ? p.slice(0, slash) : p;
    while (p.length >= root.length) {
      set.add(p);
      if (p === root) break;
      const idx = p.lastIndexOf("/");
      if (idx <= 0) break;
      p = p.slice(0, idx);
    }
  }
  return set;
}
