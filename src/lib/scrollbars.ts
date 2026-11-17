/** Do scrollbars take up room here, or float over the content?
 *
 *  It is a fact about the machine, not about the name of its OS. Windows' are
 *  classic (15px of layout). macOS's are zero-width overlays — until a mouse is
 *  plugged in, or "Show scroll bars: Always" is set, and then they are classic
 *  too. A stylesheet cannot ask, and the two want opposite handling:
 *
 *  - a classic bar left alone is the platform's own: on Windows a white slab
 *    with arrow buttons in the middle of a dark panel;
 *  - an overlay bar given a `::-webkit-scrollbar` rule BECOMES a classic one,
 *    and takes real width from its pane for nothing.
 *
 *  So this measures, and `markScrollbarKind` says the answer on the root for
 *  App.css to key on (see "scrollbars" there). */
export function scrollbarsTakeRoom(doc: Document = document): boolean {
  const probe = doc.createElement("div");
  probe.style.cssText =
    "position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll";
  doc.body.appendChild(probe);
  const taken = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return taken > 0;
}

/** Root attribute App.css keys its classic-only scrollbar rules on. */
export const CLASSIC_SCROLLBARS = "data-classic-scrollbars";

/** Record the answer on the root. Never throws: it runs before the first
 *  render, and a scrollbar's looks are not worth a window that does not open —
 *  with no attribute, every bar is simply the platform's, as it used to be. */
export function markScrollbarKind(doc: Document = document): void {
  try {
    doc.documentElement.toggleAttribute(CLASSIC_SCROLLBARS, scrollbarsTakeRoom(doc));
  } catch {
    /* leave the attribute as it was */
  }
}

/** Mark now, and again whenever the window regains focus: on macOS the answer
 *  changes while the app runs (a mouse plugged in or pulled out), and a stale
 *  "classic" would keep an 8px bar where an overlay now costs nothing. */
export function watchScrollbarKind(win: Window = window): void {
  markScrollbarKind(win.document);
  win.addEventListener("focus", () => markScrollbarKind(win.document));
}
