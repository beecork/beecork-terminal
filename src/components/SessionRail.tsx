import { useEffect, useRef, useState } from "react";
import { displayName, isDivider, type Divider, type RailItem, type Session } from "../lib/sessions";
import { Plus, Close, Pencil, Chevron, Gear } from "./icons";
import { noFocusSteal } from "../lib/keepFocus";
import { useContextMenu } from "../lib/useContextMenu";
import { copyText } from "../lib/clipboard";
import ContextMenu, { type MenuEntry } from "./ContextMenu";
import RenameInput from "./RenameInput";

interface Props {
  /** rail rows in display order: sessions and section dividers */
  items: RailItem[];
  activeId: string;
  /** background sessions that finished / rang the bell and haven't been seen */
  wantsYou: Set<string>;
  /** sessions producing output right now (busy) */
  busy: Set<string>;
  expanded: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onClose: (id: string) => void;
  onToggleExpand: () => void;
  onRename: (id: string, name: string) => void;
  onOpenSettings: () => void;
  /** new session started in a specific folder (right-click → "New session here") */
  onCreateIn: (cwd: string | undefined, afterId: string) => void;
  /** pair this session with the active one in split view */
  onSplitWith: (id: string) => void;
  /** dissolve this session's split pair */
  onUnsplit: (id: string) => void;
  /** close every session except this one */
  onCloseOthers: (id: string) => void;
  /** drag-to-reorder: move an item to just before `beforeId` (null = to the end) */
  onReorder: (id: string, beforeId: string | null) => void;
  /** insert a section divider before `beforeId` (null = at the end); returns its id */
  onAddDivider: (beforeId: string | null) => string;
  onRenameDivider: (id: string, name: string) => void;
  onRemoveDivider: (id: string) => void;
}

// The dot tells the truth about the session's state on EVERY row — which one is
// active is shown by the row highlight, not the dot, so you can see that the
// session you're on is busy too.
function dotClass(isBusy: boolean, wants: boolean): string {
  if (wants) return "rail-dot dot-attention"; // finished / waiting — blinks amber
  if (isBusy) return "rail-dot dot-busy"; // a command is running — steady blue
  return "rail-dot dot-idle"; // at the prompt — grey
}

export default function SessionRail({
  items,
  activeId,
  wantsYou,
  busy,
  expanded,
  onSelect,
  onCreate,
  onClose,
  onToggleExpand,
  onRename,
  onOpenSettings,
  onCreateIn,
  onSplitWith,
  onUnsplit,
  onCloseOthers,
  onReorder,
  onAddDivider,
  onRenameDivider,
  onRemoveDivider,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  // Menu payload: the row that was right-clicked — null means the "New session" row.
  const { menu, openMenu, closeMenu } = useContextMenu<RailItem | null>();

  const sessionCount = items.reduce((n, i) => n + (isDivider(i) ? 0 : 1), 0);

  // Drag-to-reorder — POINTER-based, not the HTML5 drag API. This is a Tauri
  // webview with OS-level drag-drop enabled (so you can drop files from Finder
  // into the terminal), and that interception stops in-page dragover/drop events
  // from ever firing. `dragId` is the row being dragged (a session or a divider);
  // `dropBefore` is where it would land (an item id to insert before, or "end" =
  // after the last one).
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startY: number; moved: boolean } | null>(null);
  const dropRef = useRef<string | "end" | null>(null);
  const lastDragEnd = useRef(0);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropBefore, setDropBefore] = useState<string | "end" | null>(null);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      if (!d) return;
      if (!d.moved) {
        if (Math.abs(e.clientY - d.startY) < 5) return; // small moves stay clicks
        d.moved = true;
        setDragId(d.id);
        document.body.style.cursor = "grabbing";
      }
      // Drop before the first row whose middle is below the cursor, else at the end.
      let before: string | "end" = "end";
      const rows = listRef.current?.querySelectorAll<HTMLElement>("[data-item-id]");
      if (rows) {
        for (const row of rows) {
          const r = row.getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) {
            before = row.dataset.itemId!;
            break;
          }
        }
      }
      dropRef.current = before;
      setDropBefore(before);
    }
    function onUp() {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d || !d.moved) return;
      document.body.style.cursor = "";
      const before = dropRef.current;
      dropRef.current = null;
      lastDragEnd.current = performance.now(); // swallow the click that follows
      setDragId(null);
      setDropBefore(null);
      if (before !== null) onReorder(d.id, before === "end" ? null : before);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onReorder]);

  // Create a divider and drop straight into naming it.
  function addDivider(beforeId: string | null) {
    const id = onAddDivider(beforeId);
    if (!expanded) onToggleExpand();
    setEditingId(id);
  }

  function sessionMenu(s: Session): MenuEntry[] {
    const isActive = s.id === activeId;
    const items: MenuEntry[] = [
      { label: "New session here", onSelect: () => onCreateIn(s.cwd, s.id) },
      {
        label: "Rename",
        onSelect: () => {
          if (!expanded) onToggleExpand();
          setEditingId(s.id);
        },
      },
      s.partner
        ? { label: "Unsplit", onSelect: () => onUnsplit(s.id) }
        : {
            label: isActive ? "Split view" : "Split with active",
            onSelect: () => onSplitWith(s.id),
          },
      { label: "Copy folder path", disabled: !s.cwd, onSelect: () => s.cwd && copyText(s.cwd) },
      { label: "Add divider above", onSelect: () => addDivider(s.id) },
      "separator",
      { label: "Close session", danger: true, onSelect: () => onClose(s.id) },
    ];
    if (sessionCount > 1) {
      items.push({ label: "Close others", danger: true, onSelect: () => onCloseOthers(s.id) });
    }
    return items;
  }

  function dividerMenu(d: Divider): MenuEntry[] {
    return [
      {
        label: "Rename",
        onSelect: () => {
          if (!expanded) onToggleExpand();
          setEditingId(d.id);
        },
      },
      "separator",
      { label: "Remove divider", onSelect: () => onRemoveDivider(d.id) },
    ];
  }

  // Right-click on the "New session" row — add a divider at the end of the list.
  function addRowMenu(): MenuEntry[] {
    return [{ label: "Add divider here", onSelect: () => addDivider(null) }];
  }

  let sessionNo = 0;
  return (
    <div className={`session-rail ${expanded ? "expanded" : "collapsed"}`}>
      <div className="rail-top">
        <button
          className="icon-btn sm"
          onClick={onToggleExpand}
          title={expanded ? "Collapse" : "Expand"}
          {...noFocusSteal}
        >
          <span className={`rail-expand-icon${expanded ? " open" : ""}`}>
            <Chevron size={16} />
          </span>
        </button>
        {expanded && <span className="rail-top-label">Sessions</span>}
      </div>

      <div className="rail-list" ref={listRef}>
        {items.map((item) => {
          if (isDivider(item)) {
            const editing = editingId === item.id;
            return (
              <div
                key={item.id}
                data-item-id={item.id}
                className={`rail-divider${dragId === item.id ? " dragging" : ""}${
                  dropBefore === item.id ? " drop-before" : ""
                }`}
                onMouseDown={(e) => {
                  if (editing || e.button !== 0) return;
                  dragRef.current = { id: item.id, startY: e.clientY, moved: false };
                }}
                onDoubleClick={() => expanded && setEditingId(item.id)}
                onContextMenu={(e) => openMenu(e, item)}
                title={item.name || "Divider — double-click to name"}
              >
                {expanded ? (
                  editing ? (
                    <RenameInput
                      className="rail-rename"
                      initialValue={item.name}
                      onCommit={(v) => {
                        onRenameDivider(item.id, v);
                        setEditingId(null);
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <>
                      <span className="rail-divider-line" />
                      {item.name && <span className="rail-divider-name">{item.name}</span>}
                      <span className="rail-divider-line" />
                      <button
                        className="rail-close"
                        title="Rename"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(item.id);
                        }}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="rail-close"
                        title="Remove divider"
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveDivider(item.id);
                        }}
                      >
                        <Close size={14} />
                      </button>
                    </>
                  )
                ) : (
                  <span className="rail-divider-line" />
                )}
              </div>
            );
          }

          const s = item;
          const n = ++sessionNo;
          const name = displayName(s);
          const isActive = s.id === activeId;
          const isBusy = busy.has(s.id);
          const wants = wantsYou.has(s.id);
          const editing = editingId === s.id;
          return (
            <div
              key={s.id}
              data-item-id={s.id}
              className={`rail-item${isActive ? " active" : ""}${wants ? " needs-you" : ""}${
                dragId === s.id ? " dragging" : ""
              }${dropBefore === s.id ? " drop-before" : ""}`}
              // Press-and-drag to reorder (pointer-based; see the effect above).
              // Disabled while renaming so the input keeps normal selection.
              onMouseDown={(e) => {
                if (editing || e.button !== 0) return;
                dragRef.current = { id: s.id, startY: e.clientY, moved: false };
              }}
              onClick={() => {
                // Swallow the click that ends a drag; a real click still selects.
                if (performance.now() - lastDragEnd.current < 250) return;
                onSelect(s.id);
              }}
              onDoubleClick={() => expanded && setEditingId(s.id)}
              onContextMenu={(e) => openMenu(e, s)}
              title={expanded ? name : `${n}. ${name}`}
            >
              <span className={dotClass(isBusy, wants)} />
              {expanded ? (
                editing ? (
                  <RenameInput
                    className="rail-rename"
                    initialValue={name}
                    onCommit={(v) => {
                      onRename(s.id, v);
                      setEditingId(null);
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    <span className="rail-name">{name}</span>
                    <button
                      className="rail-close"
                      title="Rename"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingId(s.id);
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      className="rail-close"
                      title="Close session"
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(s.id);
                      }}
                    >
                      <Close size={14} />
                    </button>
                  </>
                )
              ) : (
                // Collapsed = pure navigation. No close × here (too easy to
                // mis-hit); close from the expanded rail or the terminal window.
                <span className="rail-num">{n}</span>
              )}
            </div>
          );
        })}

        <div
          className={`rail-item rail-add-item${dropBefore === "end" ? " drop-before" : ""}`}
          onClick={onCreate}
          onContextMenu={(e) => openMenu(e, null)}
          title="New session (⌘T)"
        >
          <span className="rail-add-plus">
            <Plus size={16} />
          </span>
          {expanded && <span className="rail-name">New session</span>}
        </div>
      </div>

      <div className="rail-footer">
        <button className="rail-gear" onClick={onOpenSettings} title="Settings">
          <span className="rail-gear-ic">
            <Gear size={16} />
          </span>
          {expanded && <span className="rail-name">Settings</span>}
        </button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={
            menu.payload === null
              ? addRowMenu()
              : isDivider(menu.payload)
                ? dividerMenu(menu.payload)
                : sessionMenu(menu.payload)
          }
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
