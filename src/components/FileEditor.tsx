import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { unifiedMergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import { readFile, writeFile, gitFileOriginal, isDiskConflict } from "../lib/api";
import { basename } from "../lib/paths";
import { languageFor } from "../lib/language";
import { onFsChanged } from "../lib/events";
import { useSettings, type Surface } from "../lib/settings";

type Status = "loading" | "ready" | "error";
type Mode = "edit" | "diff";

export default function FileEditor({
  path,
  line,
  root,
  onFocusSurface,
}: {
  path: string;
  line?: number;
  root?: string | null;
  onFocusSurface: (s: Surface) => void;
}) {
  const { theme, settings } = useSettings();
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [dirty, setDirty] = useState(false);
  // A save was rejected because the file changed on disk under our edits. Until
  // the user resolves it (Overwrite or Reload), plain Save/live-reload stay stuck.
  const [conflict, setConflict] = useState(false);
  const [mode, setMode] = useState<Mode>("edit");

  const mtimeRef = useRef(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  // The terminal's cwd is READ by `load`, never depended on: it selects nothing
  // but the git repo the diff baseline comes from. Holding it in a ref pins
  // `load`'s identity to `path`, so a `cd` can no longer re-fire the mount load —
  // which ran with `initial: true`, skipped the dirty guard below, and silently
  // replaced unsaved edits with the version on disk.
  const rootRef = useRef(root);
  rootRef.current = root;
  const cmRef = useRef<ReactCodeMirrorRef>(null);

  const load = useCallback(
    (initial: boolean, force = false) => {
      if (initial) setStatus("loading");
      setError("");
      Promise.all([
        readFile(path),
        gitFileOriginal(path, rootRef.current ?? undefined).catch(() => ""),
      ])
        .then(([data, orig]) => {
          // Don't clobber unsaved edits made during an in-flight reload — unless
          // the user explicitly asked to reload (force), discarding their edits.
          if (!initial && !force && dirtyRef.current) return;
          mtimeRef.current = data.mtime;
          setContent(data.content);
          setOriginal(orig);
          setDirty(false);
          setConflict(false);
          setSaveMsg("");
          setStatus("ready");
          setMode(orig && orig !== data.content ? "diff" : "edit");
        })
        .catch((e) => {
          if (initial) {
            setError(String(e));
            setStatus("error");
          }
        });
    },
    [path]
  );

  useEffect(() => {
    load(true);
  }, [load]);

  // A `cd` in the terminal changes which repository the diff baseline comes from
  // — and nothing else. This file's path is absolute, so its CONTENTS don't
  // depend on the terminal's cwd; re-reading it here (which is what used to
  // happen) threw away unsaved edits. Refresh `original` alone and leave content,
  // dirty, mtime and the Diff/Edit mode untouched. `showDiff` already requires a
  // non-empty baseline, so if a new root has none the diff collapses on its own.
  const baselineRoot = useRef(root);
  useEffect(() => {
    if (baselineRoot.current === root) return; // the mount load already fetched this one
    baselineRoot.current = root;
    let cancelled = false;
    gitFileOriginal(path, root ?? undefined)
      .catch(() => "")
      .then((orig) => {
        // Two fast `cd`s would otherwise race and the slower reply could win.
        if (!cancelled) setOriginal(orig);
      });
    return () => {
      cancelled = true;
    };
  }, [path, root]);

  // Live-refresh when the agent edits this file — unless the user has unsaved
  // edits. Filtered to this file's path so an unrelated change elsewhere doesn't
  // re-read + re-diff every open editor.
  useEffect(() => {
    return onFsChanged(
      () => {
        if (!dirtyRef.current) load(false);
      },
      { match: (paths) => paths.includes(path) }
    );
  }, [load, path]);

  // Jump to a requested line (from a clicked terminal path).
  useEffect(() => {
    if (!line || status !== "ready") return;
    const view = cmRef.current?.view;
    if (!view) return;
    try {
      const target = view.state.doc.line(Math.min(line, view.state.doc.lines));
      view.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: "center" }),
      });
      view.focus();
    } catch {
      /* out of range */
    }
  }, [line, status, path]);

  const save = useCallback(
    async (overwrite = false) => {
      setSaveMsg("Saving…");
      try {
        // Overwrite bypasses the mtime conflict guard — the user chose to win.
        const newMtime = await writeFile(path, content, overwrite ? undefined : mtimeRef.current);
        mtimeRef.current = newMtime;
        setDirty(false);
        setConflict(false);
        setSaveMsg("Saved");
      } catch (e) {
        const msg = String(e).replace(/^Error:\s*/, "");
        // A disk-conflict is recoverable (Overwrite / Reload); other write errors
        // aren't, so only offer the escape hatch for the conflict case.
        setConflict(isDiskConflict(msg));
        setSaveMsg(msg);
      }
    },
    [path, content]
  );

  function onKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty) void save();
    }
  }

  // The panel-level toggle (settings.editorDiff) overrides everything: off means
  // every file shows plain, final content — no diff gutter, no per-file toggle.
  const hasDiff = settings.editorDiff && original != null && original !== "" && original !== content;
  const showDiff =
    settings.editorDiff && mode === "diff" && original != null && original !== "";

  // Memoised because @uiw/react-codemirror dispatches a full
  // StateEffect.reconfigure whenever this array's identity changes — and
  // reconfiguring re-inits unifiedMergeView's chunk field, i.e. re-diffs the
  // whole file. Built inline, that happened on every render, and typing
  // re-renders, so it was once per keystroke. `showDiff` deliberately does not
  // depend on `content`, so typing never invalidates this.
  const extensions = useMemo<Extension[]>(
    () => [
      ...languageFor(path),
      ...(showDiff ? [unifiedMergeView({ original: original!, mergeControls: false })] : []),
    ],
    [path, showDiff, original]
  );

  // Stable for the same reason — `onChange` sits in that same reconfigure's deps.
  const onChange = useCallback((val: string) => {
    setContent(val);
    setDirty(true);
  }, []);

  const name = basename(path);

  return (
    <div
      className="editor-region"
      onKeyDown={onKeyDown}
      onFocusCapture={() => onFocusSurface("editor")}
    >
      <div className="editor-header">
        <span className="editor-name">
          {name}
          {dirty ? " ●" : ""}
        </span>
        {hasDiff && (
          <div className="mode-toggle">
            <button className={mode === "diff" ? "active" : ""} onClick={() => setMode("diff")}>
              Diff
            </button>
            <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>
              Edit
            </button>
          </div>
        )}
        <span className="editor-status">{saveMsg}</span>
        {conflict ? (
          <>
            <button
              className="editor-save"
              title="Overwrite the version on disk with your edits"
              onClick={() => void save(true)}
            >
              Overwrite
            </button>
            <button
              className="editor-save"
              title="Discard your edits and load the version on disk"
              onClick={() => load(false, true)}
            >
              Reload
            </button>
          </>
        ) : (
          <button className="editor-save" disabled={!dirty} onClick={() => void save()}>
            Save
          </button>
        )}
      </div>
      <div className="editor-body">
        {status === "error" ? (
          <div className="editor-error">{error}</div>
        ) : status === "loading" ? (
          <div className="editor-loading">Loading…</div>
        ) : (
          <CodeMirror
            ref={cmRef}
            key={showDiff ? "diff" : "edit"}
            value={content}
            height="100%"
            theme={theme.editor === "light" ? "light" : oneDark}
            extensions={extensions}
            onChange={onChange}
          />
        )}
      </div>
    </div>
  );
}
