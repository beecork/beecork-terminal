// Keyboard selection at the prompt (Windows): Shift+Left / Shift+Right, and with
// Ctrl a word at a time — like an editor. Type "Molecule", hold Shift, tap Left:
// the word highlights, and Ctrl+C copies it (clipboardKeyAction in termKeys sees
// a selection → "copy").
//
// WHOSE SELECTION IT IS. Some programs select by themselves: PowerShell's
// PSReadLine does, paints the selection, replaces it when you type and copies
// it on Ctrl+C — and has more selection keys than these (Shift+Home, Ctrl+A).
// A second selection on top of that one can only fall out of step with it, and
// then Ctrl+C copies the wrong text. So where the program paints a selection of
// its own, the terminal stays out: it shows nothing and Ctrl+C goes to the
// program, exactly as without any of this. cmd.exe and Claude Code's input box
// have no selection at all; there the terminal provides one. The key always
// goes to the program, which moves its cursor (and, if it selects, paints).
//
// HOW IT IS BUILT, where the terminal provides it. The range runs from where the
// cursor was when the selection began (`anchor`) to wherever the PROGRAM then
// puts its cursor (`head`). The terminal never moves the head itself: counting
// key presses ran on past the end of the typed text, into blank cells and the
// lines around the prompt, while the shell's own cursor stayed put. Following
// the cursor stops the highlight where the program stops, and makes Ctrl+Shift
// select by the program's own idea of a word.
//
// But a cursor moves for other reasons than a selection key, and the screen
// changes under a selection that is being held. One rule covers all of it:
//
//   THE HIGHLIGHT ONLY EVER COVERS TEXT THAT WAS ALREADY ON SCREEN WHEN THE
//   SELECTION KEY WAS PRESSED, AND THAT HAS NOT CHANGED SINCE.
//
// Each selection key takes a snapshot of the viewport (`seen`). From then on:
//
//  - the head follows the cursor only across cells that still read what the
//    snapshot says. A program that is PRINTING moves the cursor over new text:
//    without this, one Shift+Right during a build highlighted every line the
//    build went on to print.
//  - a selection whose cells no longer read what they did is stale. If the same
//    text now sits a whole number of rows away, where the cursor went, the
//    program has redrawn its input lower down — an agent's input box moves each
//    time it prints above it — and the selection moves with it. Otherwise it is
//    dropped. (Unchecked, a selection held in Claude Code's box became the
//    whole screen the moment the reply landed: the anchor stayed behind, in
//    what had scrolled away.)
//  - cells whose BACKGROUND the program has changed since the snapshot are a
//    selection it painted itself — see above — and the terminal's is dropped.
//
// Positions are LINEAR buffer offsets (row * cols + col, rows counted from the
// top of the buffer), so a selection runs across a wrapped line the same way
// the cursor does.
//
// REPLACING IT. In an editor Delete or Backspace removes the selection and a
// typed character takes its place. A program with no selection knows nothing of
// that: Delete reached it as one ordinary delete ("hello Molecule" with "cule"
// selected became "hello Moleule") and the highlight just went away. So for
// those keys the terminal first sends the program the deletes that remove the
// selected text — forward deletes when its cursor is at the selection's start,
// backspaces when it is at the end — and only then, for a typed character, the
// key itself. This is the one place the terminal sends keys nobody pressed, so
// it does so only when it can vouch for every one of them (`keySelErase`), and
// otherwise changes nothing: the key goes to the program as it always did.

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

/** Shift+Left / Shift+Right — with or without Ctrl, which is the program's
 *  jump-a-word. Nothing else: Shift+Up/Down belong to the program's history. */
export function isSelectionKey(e: KeyLike): boolean {
  if (!e.shiftKey || e.altKey || e.metaKey) return false;
  return e.key === "ArrowLeft" || e.key === "ArrowRight";
}

/** Keys that only modify — pressing Shift (or Ctrl, on the way to Ctrl+C) must
 *  not end a keyboard selection that's in progress. */
export function isModifierOnly(e: Pick<KeyboardEvent, "key">): boolean {
  return e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta";
}

/** Does this key replace a selection, in an editor? Delete and Backspace remove
 *  it ("erase"); a typed character goes in its place ("type"). Unmodified keys
 *  only — Ctrl+Backspace, Alt+D and the like are the program's own commands, and
 *  Shift+Delete is "cut" to anything that knows the chord. (AltGr reports Ctrl
 *  and Alt both held, so a character typed with it is left alone as well: it
 *  ends the selection and is inserted, as before.) A key being composed by an
 *  input method names itself "Process" or "Dead" and is not a character yet. */
export function keySelReplaces(e: KeyLike): "erase" | "type" | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.key === "Delete" || e.key === "Backspace") return e.shiftKey ? null : "erase";
  return e.key.length === 1 ? "type" : null;
}

/** How long after a selection key a cursor move still counts as the program's
 *  answer to it. Generous — a busy agent or a remote shell can take a while —
 *  because the snapshot, not this, is what keeps wrong text out. It only stops
 *  a cursor that wanders long afterwards from stretching a finished selection. */
export const KEY_SEL_FOLLOW_MS = 1000;

/** While nothing is selected yet, this many cells before the anchor stand in
 *  for the selection when asking whether the text has moved (`witness`). */
const WITNESS_CELLS = 8;

/** What keyboard selection needs from a terminal: a grid of cells and a cursor. */
export interface KeySelScreen {
  /** cells per row */
  cols: number;
  /** offset of the viewport's first cell, and how many cells it shows */
  viewStart: number;
  viewLength: number;
  /** the cursor's offset. After the last cell of a full row a terminal holds
   *  its cursor there with the wrap pending: that is the next row's first cell
   *  here, which is how cmd.exe leaves it once such a line is typed. */
  cursor: number;
  /** the characters in the cell at `offset` — "" when it holds none */
  cell(offset: number): string;
  /** how many cells the character at `offset` takes: 2 for a wide one, whose
   *  second cell answers 0; 1 for any other cell, written or not */
  width(offset: number): number;
  /** does the row holding `offset` carry on the row above it — the TERMINAL
   *  wrapped the text there; no line break and no cursor move put it there? */
  wrapped(offset: number): boolean;
  /** the cell's background, as any value two equal backgrounds share: colour
   *  and whether it is drawn inverse. Not its text colour — a program recolours
   *  text as you type, but only a selection changes what is behind it. */
  backdrop(offset: number): string;
}

export interface KeySel {
  /** the cursor's offset when the selection began */
  anchor: number;
  /** where the program has put its cursor since */
  head: number;
  /** cursor moves are answers to a selection key until this time (ms) */
  until: number;
  /** the viewport when the last selection key was pressed, cell by cell: what
   *  each cell read, and what was behind it… */
  seen: string[];
  backdrops: string[];
  /** …and the offset the first of them stands for */
  seenAt: number;
}

type Range = { start: number; length: number };

/** The selected cells: `start` offset and `length`, or null when the head is
 *  back on the anchor (nothing selected). */
export function keySelRange(sel: Pick<KeySel, "anchor" | "head">): Range | null {
  if (sel.head === sel.anchor) return null;
  return { start: Math.min(sel.anchor, sel.head), length: Math.abs(sel.head - sel.anchor) };
}

/** The cells that tell whether the selection is still where it was: the
 *  selection itself or, while nothing is selected yet, the few cells before the
 *  anchor on its row — the prompt, or what was typed. (Without them a box that
 *  moves between the first key and its answer strands the anchor, and the first
 *  character is never selected.) */
function witness(sel: KeySel, cols: number): Range {
  const range = keySelRange(sel);
  if (range) return range;
  const start = Math.max(sel.anchor - (sel.anchor % cols), sel.anchor - WITNESS_CELLS);
  return { start, length: sel.anchor - start };
}

/** Do the `length` cells at `start + moved` read now what the snapshot recorded
 *  at `start`? A cell never written and a cell holding a space are the same
 *  blank: a repaint turns one into the other. Cells the snapshot never saw
 *  cannot be vouched for. */
function unchanged(
  screen: KeySelScreen,
  sel: KeySel,
  start: number,
  length: number,
  moved = 0
): boolean {
  for (let i = 0; i < length; i++) {
    const was = sel.seen[start + i - sel.seenAt];
    if (was === undefined) return false;
    if ((screen.cell(start + i + moved) || " ") !== (was || " ")) return false;
  }
  return true;
}

/** Has the program changed what is behind any of these cells since the
 *  snapshot? Then it paints a selection of its own. */
function repainted(screen: KeySelScreen, sel: KeySel, { start, length }: Range): boolean {
  for (let i = 0; i < length; i++) {
    const was = sel.backdrops[start + i - sel.seenAt];
    if (was !== undefined && screen.backdrop(start + i) !== was) return true;
  }
  return false;
}

/** How far the text has moved since it was seen: 0 while it is where it was,
 *  the distance when it was redrawn elsewhere, null when it is gone. Whole rows
 *  only — a program redraws its input lower or higher, never sideways — and the
 *  cursor, which went with it, says how many: the two whole numbers of rows
 *  around its own travel, since it may have answered a key on the way. */
function movedBy(screen: KeySelScreen, sel: KeySel, range: Range): number | null {
  if (unchanged(screen, sel, range.start, range.length)) return 0;
  const rows = (screen.cursor - sel.head) / screen.cols;
  for (const n of new Set([Math.round(rows), Math.floor(rows), Math.ceil(rows)])) {
    const moved = n * screen.cols;
    if (moved !== 0 && unchanged(screen, sel, range.start, range.length, moved)) return moved;
  }
  return null;
}

/** `sel`, `moved` cells further on — and its snapshot with it: what was seen
 *  there is what is here now. */
function shifted(sel: KeySel, moved: number): KeySel {
  if (moved === 0) return sel;
  return {
    ...sel,
    anchor: sel.anchor + moved,
    head: sel.head + moved,
    seenAt: sel.seenAt + moved,
  };
}

/**
 * A selection key was pressed (and goes on to the program). Returns the
 * selection to carry on with — the one in progress, if its text is still on
 * screen and the cursor is still where that selection left it — else a new one
 * starting at the cursor. Either way with a fresh snapshot of the viewport and
 * a fresh `until`.
 *
 * (The cursor test matters: a paste or a dropped file moves the cursor without
 * a key the terminal sees, and carrying on from the old anchor would then
 * select everything that was inserted.)
 */
export function keySelPress(sel: KeySel | null, screen: KeySelScreen, now: number): KeySel {
  let anchor = screen.cursor;
  let head = screen.cursor;
  if (sel) {
    const moved = movedBy(screen, sel, witness(sel, screen.cols));
    if (moved !== null && screen.cursor === sel.head + moved) {
      anchor = sel.anchor + moved;
      head = sel.head + moved;
    }
  }
  const seen = new Array<string>(screen.viewLength);
  const backdrops = new Array<string>(screen.viewLength);
  for (let i = 0; i < screen.viewLength; i++) {
    seen[i] = screen.cell(screen.viewStart + i);
    backdrops[i] = screen.backdrop(screen.viewStart + i);
  }
  return {
    anchor,
    head,
    until: now + KEY_SEL_FOLLOW_MS,
    seen,
    backdrops,
    seenAt: screen.viewStart,
  };
}

/**
 * The screen was written to while a selection is held. Returns
 *  - `sel`: the selection now — the same object when nothing changed, null when
 *    it is over (its text is gone, or the program paints its own);
 *  - `redraw`: put `sel` (or nothing) on screen;
 *  - `wait`: the text is not where it was, nor where the cursor went — but
 *    writes arrive in pieces and the pieces in between say nothing. Take the
 *    highlight off for now and call again with `settled` once the screen has
 *    been still for a moment; only then is the selection given up.
 */
export function keySelSync(
  sel: KeySel,
  screen: KeySelScreen,
  now: number,
  settled: boolean
): { sel: KeySel | null; redraw: boolean; wait: boolean } {
  const over = { sel: null, redraw: true, wait: false };
  const moved = movedBy(screen, sel, witness(sel, screen.cols));
  if (moved === null) return settled ? over : { sel, redraw: false, wait: true };
  let next = shifted(sel, moved);
  // The program's answer to a selection key: it moved its cursor. Follow — but
  // only over text that was there when the key was pressed.
  if (now <= next.until && screen.cursor !== next.head) {
    const start = Math.min(next.anchor, screen.cursor);
    if (unchanged(screen, next, start, Math.abs(screen.cursor - next.anchor))) {
      next = { ...next, head: screen.cursor };
    }
  }
  // …and painted a selection of its own while it was at it: the program's, then.
  const range = keySelRange(next);
  if (range && repainted(screen, next, range)) return over;
  // Once the screen has settled, redraw whatever the verdict: the highlight was
  // taken off while waiting.
  return { sel: next, redraw: settled || next !== sel, wait: false };
}

/** The keys that delete, as the terminal sends them when they are pressed. */
const ERASE_KEYS = { backspace: "\x7f", delete: "\x1b[3~" } as const;

/**
 * What to send the program so that IT deletes the selected text — or null when
 * that cannot be vouched for, and the key must go on alone as it always did.
 * Deleting too much is the one thing this must never do, so everything here is
 * a reason to answer null:
 *
 *  - nothing is selected, or the text is not what the last selection key saw,
 *    or the program has painted a selection of its own since (it will replace
 *    that itself — deletes on top would take the text beside it);
 *  - the program's cursor is not at the head. Deleting starts from the cursor,
 *    and only a cursor at one end of the selection deletes exactly it;
 *  - a cell holds no character, or more than one UTF-16 unit (an emoji, a
 *    letter with a combining mark). One cell is then not one press of a delete
 *    key in every program, and there is no telling which this one is;
 *  - the selection runs onto a row the terminal did not wrap by itself. An
 *    agent's input box breaks its own lines, at words and with an indent, so
 *    there the cells between two ends are not the characters between them.
 */
export function keySelErase(sel: KeySel, screen: KeySelScreen): string | null {
  const range = keySelRange(sel);
  if (!range || screen.cursor !== sel.head) return null;
  if (!unchanged(screen, sel, range.start, range.length) || repainted(screen, sel, range)) {
    return null;
  }
  let presses = 0;
  for (let at = range.start; at < range.start + range.length; at++) {
    if (at > range.start && at % screen.cols === 0 && !screen.wrapped(at)) return null;
    if (screen.width(at) === 0) continue; // the second cell of a wide character
    if (screen.cell(at).length !== 1) return null;
    presses++;
  }
  if (presses === 0) return null;
  return ERASE_KEYS[sel.head < sel.anchor ? "delete" : "backspace"].repeat(presses);
}
