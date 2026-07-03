import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { invoke, Channel } from "@tauri-apps/api/core";
import "@xterm/xterm/css/xterm.css";

type PtyEvent =
  | { event: "output"; data: string }
  | { event: "exit"; data: number };

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

export default function TerminalPane() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    let disposed = false;

    const term = new Terminal({
      fontFamily: 'Menlo, "SF Mono", Monaco, "Cascadia Code", monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#1e1e2e",
        foreground: "#cdd6f4",
        cursor: "#f5e0dc",
        selectionBackground: "#585b70",
      },
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    try {
      term.loadAddon(new WebglAddon());
    } catch (e) {
      console.warn("WebGL renderer unavailable, using default", e);
    }
    fit.fit();

    const channel = new Channel<PtyEvent>();
    channel.onmessage = (msg) => {
      if (disposed) return;
      if (msg.event === "output") {
        term.write(decodeBase64(msg.data));
      } else if (msg.event === "exit") {
        term.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
      }
    };

    invoke("pty_spawn", {
      onEvent: channel,
      cwd: null,
      shell: null,
      cols: term.cols,
      rows: term.rows,
    }).catch((e) => console.error("pty_spawn failed", e));

    const dataSub = term.onData((data) =>
      invoke("pty_write", { data }).catch(() => {})
    );
    const resizeSub = term.onResize(({ cols, rows }) =>
      invoke("pty_resize", { cols, rows }).catch(() => {})
    );

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* container not ready */
      }
    });
    ro.observe(hostRef.current);

    term.focus();

    return () => {
      disposed = true;
      ro.disconnect();
      dataSub.dispose();
      resizeSub.dispose();
      invoke("pty_kill").catch(() => {});
      term.dispose();
    };
  }, []);

  return <div className="terminal-host" ref={hostRef} />;
}
