import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { unifiedMergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import { readFile, writeFile, gitFileOriginal } from "../lib/api";
import { languageFor } from "../lib/language";
import { onFsChanged } from "../lib/events";

type Status = "loading" | "ready" | "error" | "saving" | "saved";
type Mode = "edit" | "diff";

export default function FileEditor({ path }: { path: string }) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<Mode>("edit");

  const load = useCallback(() => {
    setStatus("loading");
    setError("");
    Promise.all([readFile(path), gitFileOriginal(path).catch(() => "")])
      .then(([c, orig]) => {
        setContent(c);
        setOriginal(orig);
        setDirty(false);
        setStatus("ready");
        setMode(orig && orig !== c ? "diff" : "edit");
      })
      .catch((e) => {
        setError(String(e));
        setStatus("error");
      });
  }, [path]);

  useEffect(() => {
    load();
  }, [load]);

  // Live-refresh when the agent edits this file — unless the user has unsaved edits.
  useEffect(() => {
    return onFsChanged(() => {
      if (!dirty) load();
    });
  }, [load, dirty]);

  const save = useCallback(async () => {
    setStatus("saving");
    try {
      await writeFile(path, content);
      setDirty(false);
      setStatus("saved");
    } catch (e) {
      setError(String(e));
      setStatus("error");
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
    <div className="editor-region" onKeyDown={onKeyDown}>
      <div className="editor-header">
        <span className="editor-name">
          {name}
          {dirty ? " ●" : ""}
        </span>
        {hasDiff && (
          <div className="mode-toggle">
            <button
              className={mode === "diff" ? "active" : ""}
              onClick={() => setMode("diff")}
            >
              Diff
            </button>
            <button
              className={mode === "edit" ? "active" : ""}
              onClick={() => setMode("edit")}
            >
              Edit
            </button>
          </div>
        )}
        <span className="editor-status">
          {status === "saving" && "Saving…"}
          {status === "saved" && !dirty && "Saved"}
        </span>
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
            key={showDiff ? "diff" : "edit"}
            value={content}
            height="100%"
            theme={oneDark}
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
