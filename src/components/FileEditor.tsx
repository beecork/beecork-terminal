import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { EditorView } from "@codemirror/view";
import { oneDark } from "@codemirror/theme-one-dark";
import { unifiedMergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import { readFile, writeFile, gitFileOriginal } from "../lib/api";
import { languageFor } from "../lib/language";
import { onFsChanged } from "../lib/events";
import { useSettings } from "../lib/settings";

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
  onFocusSurface: (s: "terminal" | "editor") => void;
}) {
  const { theme } = useSettings();
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<Mode>("edit");

  const mtimeRef = useRef(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const cmRef = useRef<ReactCodeMirrorRef>(null);

  const load = useCallback(
    (initial: boolean) => {
      if (initial) setStatus("loading");
      setError("");
      Promise.all([readFile(path), gitFileOriginal(path, root ?? undefined).catch(() => "")])
        .then(([data, orig]) => {
          // Don't clobber unsaved edits made during an in-flight reload.
          if (!initial && dirtyRef.current) return;
          mtimeRef.current = data.mtime;
          setContent(data.content);
          setOriginal(orig);
          setDirty(false);
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
    [path, root]
  );

  useEffect(() => {
    load(true);
  }, [load]);

  // Live-refresh when the agent edits this file — unless the user has unsaved edits.
  useEffect(() => {
    return onFsChanged(() => {
      if (!dirtyRef.current) load(false);
    });
  }, [load]);

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

  const save = useCallback(async () => {
    setSaveMsg("Saving…");
    try {
      const newMtime = await writeFile(path, content, mtimeRef.current);
      mtimeRef.current = newMtime;
      setDirty(false);
      setSaveMsg("Saved");
    } catch (e) {
      // Conflict (or write error) — keep the editor and the user's edits visible.
      setSaveMsg(String(e).replace(/^Error:\s*/, ""));
    }
  }, [path, content]);

  function onKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (dirty) void save();
    }
  }

  const hasDiff = original != null && original !== "" && original !== content;
  const showDiff = mode === "diff" && original != null && original !== "";

  const extensions: Extension[] = [
    ...languageFor(path),
    ...(showDiff ? [unifiedMergeView({ original: original!, mergeControls: false })] : []),
  ];

  const name = path.split("/").pop() ?? path;

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
        <button className="editor-save" disabled={!dirty} onClick={() => void save()}>
          Save
        </button>
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
            onChange={(val) => {
              setContent(val);
              setDirty(true);
            }}
          />
        )}
      </div>
    </div>
  );
}
