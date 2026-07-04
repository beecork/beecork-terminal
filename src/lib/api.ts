import { invoke } from "@tauri-apps/api/core";

export interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
}

export interface Listing {
  path: string;
  entries: Entry[];
}

export const getRoot = () => invoke<string>("get_root");

export interface PtyStatus {
  /** the shell's working directory (follows `cd`) */
  cwd: string | null;
  /** the command running at the prompt, e.g. "claude" (null when idle) */
  running: string | null;
}

/** A session's live status — where its shell is and what it's running. */
export const ptyStatus = (id: string) => invoke<PtyStatus>("pty_status", { id });

export const listDir = (path?: string) =>
  invoke<Listing>("list_dir", { path: path ?? null });

export interface FileData {
  content: string;
  /** last-modified time (ms since epoch) for conflict detection */
  mtime: number;
}

export const readFile = (path: string) =>
  invoke<FileData>("read_file", { path });

/** Writes the file; rejects if it changed on disk since `expectedMtime`. Returns the new mtime. */
export const writeFile = (path: string, content: string, expectedMtime?: number) =>
  invoke<number>("write_file", { path, content, expectedMtime: expectedMtime ?? null });

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
