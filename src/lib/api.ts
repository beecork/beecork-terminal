import { invoke, convertFileSrc } from "@tauri-apps/api/core";

/**
 * A webview-loadable URL for a local file, served over Tauri's asset protocol.
 * Streams the file (so video/audio can seek) instead of shipping bytes over IPC.
 * Requires `app.security.assetProtocol` to be enabled + in scope (see tauri.conf.json).
 */
export const fileSrc = (path: string) => convertFileSrc(path);

export interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface Listing {
  entries: Entry[];
}

export const getRoot = () => invoke<string>("get_root");

/** The user's home directory — the sensible default startup folder. */
export const getHomeDir = () => invoke<string>("home_dir");

/** Reveal a path in the OS file manager (Finder / Explorer). */
export const revealPath = (path: string) => invoke<void>("reveal_path", { path });

/** Open an http(s) URL in the user's default browser. */
export const openUrl = (url: string) => invoke<void>("open_url", { url });

/** Rename / move a filesystem entry (rejects if the target exists). */
export const renamePath = (from: string, to: string) =>
  invoke<void>("rename_path", { from, to });

/** Create an empty file or a directory (rejects if the path exists). */
export const createPath = (path: string, isDir: boolean) =>
  invoke<void>("create_path", { path, isDir });

/** Move a path to the OS trash (recoverable). */
export const deletePath = (path: string) => invoke<void>("delete_path", { path });

export interface PtyStatus {
  /** the shell's working directory (follows `cd`) */
  cwd: string | null;
  /** the command running at the prompt, e.g. "claude" (null when idle) */
  running: string | null;
  /** the running agent's conversation id, so resume reopens *this* tab's own
   *  chat rather than the last one used (null when unknown/not an agent) */
  agent_session: string | null;
}

/**
 * Live status for many sessions in one call (a single process refresh serves all).
 * `withAgents` also pins each running agent's conversation id — a transcript
 * directory scan per agent, so ask for it on a slow cadence, not every tick.
 */
export const ptyStatusAll = (ids: string[], withAgents = false) =>
  invoke<Record<string, PtyStatus>>("pty_status_all", { ids, withAgents });

/** A single session's live status — a thin convenience over the batched command. */
export const ptyStatus = (id: string, withAgents = false): Promise<PtyStatus> =>
  ptyStatusAll([id], withAgents).then(
    (m) => m[id] ?? { cwd: null, running: null, agent_session: null }
  );

/**
 * `cd` a session into a folder. The path is quoted in Rust, for the shell that
 * session actually runs — the webview can only guess the platform from a user
 * agent, and "Windows" isn't one shell but two (cmd.exe and PowerShell quote
 * incompatibly). Submits with Enter.
 */
export const ptyCd = (id: string, dir: string) => invoke<void>("pty_cd", { id, dir });

/** Type shell-quoted paths at a session's prompt (drag-and-drop), without submitting. */
export const ptyInsertPaths = (id: string, paths: string[]) =>
  invoke<void>("pty_insert_paths", { id, paths });

/** Re-root the file watcher to follow the active terminal's working directory. */
export const setWatchRoot = (root: string) =>
  invoke<void>("set_watch_root", { root });

export const listDir = (path?: string) =>
  invoke<Listing>("list_dir", { path: path ?? null });

export interface FileData {
  content: string;
  /** last-modified time (ms since epoch) for conflict detection */
  mtime: number;
}

export const readFile = (path: string) =>
  invoke<FileData>("read_file", { path });

/** Byte size of a file — used to guard image preview against huge decodes. */
export const fileSize = (path: string) => invoke<number>("file_size", { path });

/** Writes the file; rejects if it changed on disk since `expectedMtime`. Returns the new mtime. */
export const writeFile = (path: string, content: string, expectedMtime?: number) =>
  invoke<number>("write_file", { path, content, expectedMtime: expectedMtime ?? null });

/**
 * Was a failed `writeFile` the RECOVERABLE kind — the file changed on disk under
 * your edits — rather than a fatal one? That distinction is what puts the
 * Overwrite / Reload buttons on screen instead of a dead end.
 *
 * Keyed on the wording of `write_file`'s conflict error in `src-tauri/src/fs.rs`
 * (`CONFLICT_MSG`). The two must change together: reword the Rust string and this
 * silently stops matching, so a save just fails with no way out. `api.test.ts`
 * and that file's own test are the tripwire.
 */
export const isDiskConflict = (msg: string) => /changed on disk/i.test(msg);

export type ChangeStatus =
  | "untracked"
  | "added"
  | "modified"
  | "deleted"
  | "renamed";

export interface FileStatus {
  path: string;
  status: ChangeStatus;
}

export const gitStatus = (root?: string) =>
  invoke<FileStatus[]>("git_status", { root: root ?? null });

export const gitFileOriginal = (path: string, root?: string) =>
  invoke<string>("git_file_original", { path, root: root ?? null });
