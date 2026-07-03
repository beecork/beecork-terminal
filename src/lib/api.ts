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

export const listDir = (path?: string) =>
  invoke<Listing>("list_dir", { path: path ?? null });

export const readFile = (path: string) =>
  invoke<string>("read_file", { path });

export const writeFile = (path: string, content: string) =>
  invoke<void>("write_file", { path, content });

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
