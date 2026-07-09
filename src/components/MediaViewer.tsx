import { useEffect, useState } from "react";
import { fileSrc, fileSize, revealPath } from "../lib/api";
import { basename, mediaKind } from "../lib/paths";
import type { Surface } from "../lib/settings";

// An <img> fully decodes into webview memory (unlike streamed video/audio), and
// the asset protocol bypasses read_file's size cap — so guard image previews here.
const IMAGE_MAX_BYTES = 30 * 1024 * 1024;

/**
 * Previews a non-text file (image / video / audio) inline via the asset protocol.
 * Anything it can't render (or that fails to load) falls back to a card with a
 * "Reveal in Finder" escape hatch — so the viewer never just shows a raw error.
 */
export default function MediaViewer({
  path,
  onFocusSurface,
}: {
  path: string;
  onFocusSurface: (s: Surface) => void;
}) {
  const kind = mediaKind(path);
  const [failed, setFailed] = useState(false);
  const [oversize, setOversize] = useState(false);
  const src = fileSrc(path);
  const name = basename(path);

  // Only images need the guard; check size before decoding a huge bitmap.
  useEffect(() => {
    if (kind !== "image") return;
    let cancelled = false;
    fileSize(path)
      .then((bytes) => {
        if (!cancelled && bytes > IMAGE_MAX_BYTES) setOversize(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [path, kind]);

  const showFallback = failed || oversize || !kind;
  const fallbackTitle = oversize ? "Image too large to preview" : "No preview available";

  return (
    <div
      className="editor-region"
      onMouseDown={() => onFocusSurface("editor")}
    >
      <div className="editor-header">
        <span className="editor-name">{name}</span>
        <span className="editor-status" />
        <button
          className="editor-save"
          title="Reveal this file in Finder"
          onClick={() => revealPath(path).catch(() => {})}
        >
          Reveal
        </button>
      </div>
      <div className="editor-body media-body">
        {showFallback ? (
          <div className="media-fallback">
            <div className="media-fallback-title">{fallbackTitle}</div>
            <div className="media-fallback-name">{name}</div>
            <button className="editor-save" onClick={() => revealPath(path).catch(() => {})}>
              Reveal in Finder
            </button>
          </div>
        ) : kind === "image" ? (
          <img className="media-image" src={src} alt={name} onError={() => setFailed(true)} />
        ) : kind === "video" ? (
          <video
            className="media-video"
            src={src}
            controls
            aria-label={name}
            onError={() => setFailed(true)}
          />
        ) : (
          <audio
            className="media-audio"
            src={src}
            controls
            aria-label={name}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}
