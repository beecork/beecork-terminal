import { describe, it, expect } from "vitest";
import {
  isModifierOnly,
  isSelectionKey,
  keySelPress,
  keySelRange,
  keySelSync,
  KEY_SEL_FOLLOW_MS,
  type KeySel,
  type KeySelScreen,
} from "./keySelection";

const key = (k: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

const COLS = 40;

/** A terminal the tests can write on: rows of text, a cursor, a viewport. */
class Screen implements KeySelScreen {
  cols = COLS;
  /** first buffer row the viewport shows, and how many it shows */
  top = 0;
  height = 12;
  rows: string[] = [];
  /** cells whose background is not the default, by offset */
  painted = new Map<number, string>();
  row = 0;
  col = 0;

  get viewStart() {
    return this.top * this.cols;
  }
  get viewLength() {
    return this.height * this.cols;
  }
  /** `to(row, COLS)`: held after the row's last cell, the wrap pending. */
  get cursor() {
    return this.row * this.cols + this.col;
  }
  cell(offset: number) {
    return (this.rows[Math.floor(offset / this.cols)] ?? "").charAt(offset % this.cols);
  }
  backdrop(offset: number) {
    return this.painted.get(offset) ?? "default";
  }

  /** Put `text` on a row, replacing what was there. */
  put(row: number, text: string) {
    this.rows[row] = text;
    return this;
  }
  /** Move the cursor. */
  to(row: number, col: number) {
    this.row = row;
    this.col = col;
    return this;
  }
  /** The program paints (or, with `null`, unpaints) a selection of its own. */
  paint(row: number, from: number, to: number, backdrop: string | null = "selected") {
    for (let col = from; col < to; col++) {
      if (backdrop === null) this.painted.delete(this.at(row, col));
      else this.painted.set(this.at(row, col), backdrop);
    }
    return this;
  }
  at(row: number, col: number) {
    return row * this.cols + col;
  }
  /** The text a selection covers on its (single) row. */
  text(sel: KeySel | null) {
    const r = sel && keySelRange(sel);
    if (!r) return "";
    let out = "";
    for (let i = 0; i < r.length; i++) out += this.cell(r.start + i) || " ";
    return out;
  }
}

/** A prompt on row 5 with `typed` after it and the cursor at its end. */
function prompt(typed: string) {
  const s = new Screen();
  s.put(5, "C:\\dir> " + typed).to(5, 8 + typed.length);
  return s;
}

/** The program answered: it moved its cursor. Returns the selection after. */
function answer(s: Screen, sel: KeySel, row: number, col: number, now = 1) {
  s.to(row, col);
  const r = keySelSync(sel, s, now, false);
  expect(r.wait).toBe(false);
  return r;
}

const OVER = { sel: null, redraw: true, wait: false };

describe("selection keys", () => {
  it("are Shift+Left and Shift+Right, with or without Ctrl", () => {
    expect(isSelectionKey(key("ArrowLeft", { shiftKey: true }))).toBe(true);
    expect(isSelectionKey(key("ArrowRight", { shiftKey: true }))).toBe(true);
    // Ctrl+Shift: the program jumps a word and the highlight follows its cursor.
    expect(isSelectionKey(key("ArrowLeft", { shiftKey: true, ctrlKey: true }))).toBe(true);
    expect(isSelectionKey(key("ArrowRight", { shiftKey: true, ctrlKey: true }))).toBe(true);
  });

  it("are nothing else", () => {
    expect(isSelectionKey(key("ArrowLeft"))).toBe(false);
    expect(isSelectionKey(key("ArrowLeft", { ctrlKey: true }))).toBe(false);
    expect(isSelectionKey(key("ArrowUp", { shiftKey: true }))).toBe(false);
    expect(isSelectionKey(key("ArrowLeft", { shiftKey: true, altKey: true }))).toBe(false);
    expect(isSelectionKey(key("ArrowLeft", { shiftKey: true, metaKey: true }))).toBe(false);
    expect(isSelectionKey(key("Home", { shiftKey: true }))).toBe(false);
  });

  it("modifier-only keys don't count as input that ends a selection", () => {
    expect(isModifierOnly({ key: "Shift" })).toBe(true);
    expect(isModifierOnly({ key: "Control" })).toBe(true);
    expect(isModifierOnly({ key: "c" })).toBe(false);
    expect(isModifierOnly({ key: "ArrowLeft" })).toBe(false);
  });
});

describe("the selected range", () => {
  it("runs between anchor and head, whichever way round", () => {
    expect(keySelRange({ anchor: 18, head: 15 })).toEqual({ start: 15, length: 3 });
    expect(keySelRange({ anchor: 10, head: 12 })).toEqual({ start: 10, length: 2 });
  });

  it("is nothing while the head is on the anchor", () => {
    expect(keySelRange({ anchor: 18, head: 18 })).toBeNull();
  });
});

describe("following the program's cursor", () => {
  it("selects one cell per Shift+Left, as the program moves", () => {
    const s = prompt("Molecule");
    let sel = keySelPress(null, s, 0);
    expect(keySelRange(sel)).toBeNull(); // nothing yet: the program has not answered

    let r = answer(s, sel, 5, 15);
    expect(r.redraw).toBe(true);
    expect(s.text(r.sel)).toBe("e");

    sel = keySelPress(r.sel, s, 10);
    r = answer(s, sel, 5, 14, 11);
    sel = keySelPress(r.sel, s, 20);
    r = answer(s, sel, 5, 13, 21);
    expect(s.text(r.sel)).toBe("ule");
    expect(r.sel?.anchor).toBe(s.at(5, 16));
  });

  it("stops where the program stops", () => {
    const s = prompt("Mol");
    let sel = keySelPress(null, s, 0);
    for (let col = 10; col >= 8; col--) sel = keySelPress(answer(s, sel, 5, col).sel, s, 0);
    expect(s.text(sel)).toBe("Mol");

    // More presses at the start of the input: the shell's cursor stays, and a
    // write that moves nothing changes nothing.
    const r = keySelSync(sel, s, 1, false);
    expect(r).toEqual({ sel, redraw: false, wait: false });
    expect(r.sel).toBe(sel);
  });

  it("selects a word at a time when the program jumps a word", () => {
    const s = prompt("one two three");
    const r = answer(s, keySelPress(null, s, 0), 5, 16);
    expect(s.text(r.sel)).toBe("three");
    const again = answer(s, keySelPress(r.sel, s, 0), 5, 12);
    expect(s.text(again.sel)).toBe("two three");
  });

  it("comes back through the anchor and out the other side", () => {
    const s = prompt("abcdef").to(5, 11); // cursor inside the text: abc|def
    let r = answer(s, keySelPress(null, s, 0), 5, 10);
    expect(s.text(r.sel)).toBe("c");
    r = answer(s, keySelPress(r.sel, s, 0), 5, 11);
    expect(keySelRange(r.sel!)).toBeNull();
    expect(r.redraw).toBe(true); // the highlight has to come off
    r = answer(s, keySelPress(r.sel, s, 0), 5, 12);
    expect(s.text(r.sel)).toBe("d");
  });

  it("runs across a wrapped line the way the cursor does", () => {
    const s = new Screen();
    s.put(5, "x".repeat(COLS)).put(6, "yz").to(6, 2);
    const r = answer(s, keySelPress(null, s, 0), 5, COLS - 1);
    expect(keySelRange(r.sel!)).toEqual({ start: s.at(5, COLS - 1), length: 3 });
  });

  it("takes a cursor held after a full row's last cell as the next row's first", () => {
    // cmd.exe once a line that exactly fills the row is typed: the wrap is
    // pending. Shift+Left then selects the last character.
    const s = new Screen();
    s.put(5, "x".repeat(COLS - 1) + "Z").to(5, COLS);
    const r = answer(s, keySelPress(null, s, 0), 5, COLS - 1);
    expect(s.text(r.sel)).toBe("Z");
  });

  it("still follows an answer that arrives at the end of the window, and not one after it", () => {
    const s = prompt("Molecule");
    const sel = keySelPress(null, s, 100);
    expect(answer(s, sel, 5, 15, 100 + KEY_SEL_FOLLOW_MS).sel?.head).toBe(s.at(5, 15));
    // Long after the key, a cursor that wanders over the same text is not an
    // answer to it: the finished selection is left as it is.
    const late = keySelSync(sel, s.to(5, 12), 100 + KEY_SEL_FOLLOW_MS + 1, false);
    expect(late).toEqual({ sel, redraw: false, wait: false });
  });
});

describe("a program that selects by itself", () => {
  // PSReadLine paints what it selects: the cells get another background.

  it("is left to it: the first Shift+Left it paints ends the terminal's selection", () => {
    const s = prompt("Molecule");
    const sel = keySelPress(null, s, 0);
    s.paint(5, 15, 16).to(5, 15);
    expect(keySelSync(sel, s, 1, false)).toEqual(OVER);
  });

  it("…and so does every later key, each one a selection that never shows", () => {
    const s = prompt("Molecule").paint(5, 15, 16).to(5, 15);
    // A word at a time, three more cells painted:
    const sel = keySelPress(null, s, 0);
    s.paint(5, 12, 15).to(5, 12);
    expect(keySelSync(sel, s, 1, false)).toEqual(OVER);
  });

  it("is left to it when a key UNPAINTS: shrinking a selection the terminal never saw made", () => {
    // Shift+Home selected the whole input natively; Shift+Right now gives one
    // character back. Mirrored, that character would be highlighted — and
    // Ctrl+C would copy it instead of what the program has selected.
    const s = prompt("Molecule").paint(5, 8, 16).to(5, 8);
    const sel = keySelPress(null, s, 0);
    s.paint(5, 8, 9, null).to(5, 9);
    expect(keySelSync(sel, s, 1, false)).toEqual(OVER);
  });

  it("is not confused with one that merely has coloured cells nearby", () => {
    // A painted cell that was already painted when the key was pressed, and is
    // not touched by the answer, says nothing.
    const s = prompt("Molecule").paint(5, 0, 7, "prompt colour");
    const r = answer(s, keySelPress(null, s, 0), 5, 13);
    expect(s.text(r.sel)).toBe("ule");
  });
});

describe("text that was not there when the key was pressed", () => {
  it("is never selected: a program that is printing moves the cursor too", () => {
    // Shift+Right while a build prints. The cursor sits on the empty line the
    // next output will fill.
    const s = new Screen();
    s.put(8, "line 6 of output").to(9, 0);
    const sel = keySelPress(null, s, 0);

    s.put(9, "line 7 of output").to(10, 0);
    let r = keySelSync(sel, s, 1, false);
    expect(r).toEqual({ sel, redraw: false, wait: false });

    s.put(10, "line 8 of output").to(11, 0);
    r = keySelSync(sel, s, 2, false);
    expect(keySelRange(r.sel!)).toBeNull();
  });

  it("is never selected: a key the program answers by typing", () => {
    // A shell that does not know Shift+Left inserts the tail of its escape
    // sequence instead of moving.
    const s = prompt("echo hi");
    const sel = keySelPress(null, s, 0);
    s.put(5, "C:\\dir> echo hi;2D").to(5, 18);
    expect(keySelSync(sel, s, 1, false).sel).toBe(sel);
  });

  it("is never selected: cells the snapshot did not cover", () => {
    const s = prompt("Molecule");
    s.top = 3;
    s.put(1, "far above the viewport");
    const sel = keySelPress(null, s, 0);
    expect(keySelSync(sel, s.to(1, 0), 1, false).sel).toBe(sel);
  });

  it("treats a blank cell and a space as the same blank", () => {
    // A repaint writes spaces where there was nothing, or the reverse.
    const s = new Screen();
    s.put(5, "> ab").put(6, "cd").to(6, 2);
    const sel = keySelPress(null, s, 0);
    s.put(5, "> ab" + " ".repeat(COLS - 4));
    const r = answer(s, sel, 5, 2);
    expect(keySelRange(r.sel!)).toEqual({ start: s.at(5, 2), length: COLS });
  });
});

describe("a selection that is being held", () => {
  /** "hello world" typed at a prompt on row 5, with "world" selected. */
  function held() {
    const s = prompt("hello world");
    let sel = keySelPress(null, s, 0);
    for (let col = 18; col >= 14; col--) sel = keySelPress(answer(s, sel, 5, col).sel, s, 0);
    expect(s.text(sel)).toBe("world");
    return { s, sel };
  }

  it("is dropped when something else writes over it", () => {
    // A background job prints into the prompt line.
    const { s, sel } = held();
    s.put(5, "C:\\dir> hello BG OUTPUT 1").to(6, 0);

    // Not yet: a redraw can arrive in pieces, and this may be the middle of
    // one. Until the screen settles the highlight is taken off, not left on
    // cells that now read something else.
    expect(keySelSync(sel, s, 5000, false)).toEqual({ sel, redraw: false, wait: true });
    // Settled, and the text is gone.
    expect(keySelSync(sel, s, 5100, true)).toEqual(OVER);
  });

  it("is kept through a redraw that arrives in pieces", () => {
    const { s, sel } = held();
    const row = s.rows[5];
    s.put(5, ""); // the row is erased first…
    expect(keySelSync(sel, s, 50, false).wait).toBe(true);
    s.put(5, row); // …and then written again, the same
    const r = keySelSync(sel, s, 60, true);
    expect(r.sel).toBe(sel);
    expect(r.redraw).toBe(true); // it was taken off while waiting
  });

  it("moves at once with an input box the program redraws lower down", () => {
    // An agent prints its reply above its input box: the box is drawn again
    // three rows lower, its old rows now hold the reply.
    const { s, sel } = held();
    s.put(5, "the reply, line 1").put(6, "the reply, line 2").put(7, "the reply, line 3");
    s.put(8, "C:\\dir> hello world").to(8, 14);

    const r = keySelSync(sel, s, 2000, false);
    expect(r.wait).toBe(false);
    expect(r.redraw).toBe(true);
    expect(r.sel?.anchor).toBe(sel.anchor + 3 * COLS);
    expect(r.sel?.head).toBe(sel.head + 3 * COLS);
    expect(s.text(r.sel)).toBe("world");

    // The next Shift+Left carries on from there.
    const next = answer(s, keySelPress(r.sel, s, 3000), 8, 13, 3001);
    expect(s.text(next.sel)).toBe(" world");
  });

  it("moves with a box redrawn higher up", () => {
    // The screen was cleared and the box drawn again near the top.
    const { s, sel } = held();
    s.put(5, "").put(2, "C:\\dir> hello world").to(2, 14);
    const r = keySelSync(sel, s, 2000, false);
    expect(s.text(r.sel)).toBe("world");
    expect(r.sel?.head).toBe(s.at(2, 14));
  });

  it("moves with a box that scrolled out of the old viewport altogether", () => {
    const { s, sel } = held();
    for (let row = 5; row < 5 + 300; row++) s.put(row, "reply line " + row);
    s.top = 300;
    s.put(305, "C:\\dir> hello world").to(305, 14);

    const r = keySelSync(sel, s, 2000, false);
    expect(s.text(r.sel)).toBe("world");
    expect(r.sel?.head).toBe(s.at(305, 14));
  });

  it("moves with the box and follows a key answered in the same update", () => {
    const { s, sel } = held();
    const pressed = keySelPress(sel, s, 1000); // Shift+Left, as the reply lands
    s.put(5, "the reply").put(6, "C:\\dir> hello world").to(6, 13);

    const r = keySelSync(pressed, s, 1010, false);
    expect(s.text(r.sel)).toBe(" world");
    expect(r.sel?.anchor).toBe(s.at(6, 19));
  });

  it("…also when that key jumped a word most of a row long", () => {
    // The cursor's own travel is no longer near a whole number of rows; both
    // whole numbers around it are tried.
    const s = new Screen();
    s.put(5, "> " + "w".repeat(30) + " tail").to(5, 37);
    let sel = keySelPress(null, s, 0);
    sel = answer(s, sel, 5, 33).sel!; // "tail"
    const pressed = keySelPress(sel, s, 1000); // Ctrl+Shift+Left, as a reply lands
    s.put(5, "the reply").put(6, "> " + "w".repeat(30) + " tail").to(6, 2);

    const r = keySelSync(pressed, s, 1010, false);
    expect(r.sel?.anchor).toBe(s.at(6, 37));
    expect(r.sel?.head).toBe(s.at(6, 2));
  });

  it("is dropped when its text is not where the cursor went", () => {
    const { s, sel } = held();
    s.put(5, "something else entirely").put(9, "C:\\dir> another prompt").to(9, 22);
    expect(keySelSync(sel, s, 2000, true)).toEqual(OVER);
  });

  it("is redrawn once the screen settles, even unchanged", () => {
    const { s, sel } = held();
    expect(keySelSync(sel, s, 5000, true)).toEqual({ sel, redraw: true, wait: false });
  });
});

describe("before anything is selected", () => {
  it("the anchor moves with its box too", () => {
    // Shift+Left, and before the program answers its box is redrawn a row
    // lower. Without the cells before the anchor to go by, the anchor stayed
    // behind and the first character was never selected.
    const s = prompt("hello world");
    const sel = keySelPress(null, s, 0);
    s.put(5, "a reply").put(6, "C:\\dir> hello world").to(6, 18);
    const r = keySelSync(sel, s, 10, false);
    expect(r.sel?.anchor).toBe(s.at(6, 19));
    expect(s.text(r.sel)).toBe("d");
  });
});

describe("the next selection key", () => {
  it("starts from the cursor when nothing is selected yet", () => {
    const s = prompt("Molecule");
    const first = keySelPress(null, s, 0); // at the end of the input: no answer
    const next = keySelPress(first, s.to(5, 10), 500);
    expect(next.anchor).toBe(s.at(5, 10));
    expect(next.head).toBe(s.at(5, 10));
  });

  it("carries on from a selection that is still there", () => {
    const s = prompt("Molecule");
    const r = answer(s, keySelPress(null, s, 0), 5, 15);
    const next = keySelPress(r.sel, s, 5000);
    expect(next.anchor).toBe(r.sel!.anchor);
    expect(next.head).toBe(r.sel!.head);
    expect(next.until).toBe(5000 + KEY_SEL_FOLLOW_MS);
  });

  it("carries on from a selection that moved with its box", () => {
    const s = prompt("Molecule");
    const r = answer(s, keySelPress(null, s, 0), 5, 13);
    s.put(5, "a reply").put(6, "C:\\dir> Molecule").to(6, 13);
    const next = keySelPress(r.sel, s, 5000);
    expect(s.text(next)).toBe("ule");
    expect(next.anchor).toBe(s.at(6, 16));
  });

  it("starts over when the selected text has gone", () => {
    const s = prompt("Molecule");
    const r = answer(s, keySelPress(null, s, 0), 5, 13);
    s.put(5, "C:\\dir> something new").to(5, 21);
    const next = keySelPress(r.sel, s, 5000);
    expect(keySelRange(next)).toBeNull();
    expect(next.anchor).toBe(s.at(5, 21));
  });

  it("starts over when the cursor is not where the selection left it", () => {
    // A file dropped on the terminal, a paste from the menu: text arrives at
    // the cursor without a key. Carrying on from the old anchor would select
    // everything that was inserted.
    const s = prompt("see ");
    const r = answer(s, keySelPress(null, s, 0), 5, 8); // "see " selected, cursor at its start
    s.put(5, "C:\\dir> C:\\some\\dropped\\file.txt see ").to(5, 33);
    // (the selected text itself moved along the row: gone from where it was)
    const next = keySelPress(r.sel, s, 5000);
    expect(keySelRange(next)).toBeNull();

    // …and when the text is untouched but the cursor went elsewhere:
    const t = prompt("alpha beta");
    const held = answer(t, keySelPress(null, t, 0), 5, 14); // "beta"
    const moved = keySelPress(held.sel, t.to(5, 10), 5000);
    expect(keySelRange(moved)).toBeNull();
    expect(moved.anchor).toBe(t.at(5, 10));
  });

  it("takes a fresh look at the screen", () => {
    const s = prompt("Molecule");
    const first = keySelPress(null, s, 0);
    s.put(5, "C:\\dir> Molecules").to(5, 17); // the user typed one more letter…
    const next = keySelPress(null, s, 10); // …and selects again
    expect(next.seen).not.toBe(first.seen);
    expect(s.text(answer(s, next, 5, 16, 11).sel)).toBe("s");
  });
});
