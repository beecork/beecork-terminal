import { useEffect, useRef, useState } from "react";
import TerminalPane from "./components/TerminalPane";
import SidePanel from "./components/SidePanel";
import "./App.css";

export default function App() {
  const [panelOpen, setPanelOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(380);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    function move(e: MouseEvent) {
      if (!dragging.current) return;
      const w = window.innerWidth - e.clientX;
      setPanelWidth(Math.min(Math.max(w, 240), window.innerWidth - 260));
    }
    function up() {
      dragging.current = false;
      document.body.style.cursor = "";
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  return (
    <div className="workspace">
      <div className="terminal-pane">
        <TerminalPane />
      </div>

      {panelOpen && (
        <div
          className="divider"
          onMouseDown={(e) => {
            dragging.current = true;
            document.body.style.cursor = "col-resize";
            e.preventDefault();
          }}
        />
      )}

      {panelOpen && (
        <div className="side-panel" style={{ width: panelWidth }}>
          <SidePanel openFile={openFile} onOpenFile={setOpenFile} />
        </div>
      )}

      <button
        className="panel-toggle"
        onClick={() => setPanelOpen((o) => !o)}
        title={panelOpen ? "Hide file panel" : "Show file panel"}
      >
        {panelOpen ? "⇥" : "⇤"}
      </button>
    </div>
  );
}
