// The bundled Georgian face (see src/fonts.css). It only covers the Georgian
// Unicode blocks, so putting it first changes nothing for other text.
export const GEORGIAN_FAMILY = '"Beecork Georgian"';

/** The user's font stack with the bundled Georgian face in front of it.
 *  Applied at use time, never written back to settings, so existing saved
 *  settings get Georgian support without a migration. */
export function withGeorgian(fontFamily: string): string {
  const stack = fontFamily.trim();
  if (stack.toLowerCase().includes(GEORGIAN_FAMILY.toLowerCase())) return stack;
  return stack ? `${GEORGIAN_FAMILY}, ${stack}` : `${GEORGIAN_FAMILY}, monospace`;
}

/** unicode-range faces download lazily, on first use of a Georgian glyph. A
 *  renderer that rasterises glyphs into a cache (xterm's WebGL atlas on
 *  macOS/Linux) would keep a fallback glyph drawn before that, so load the
 *  face up front. Resolves when ready; never rejects. */
export function preloadGeorgianFont(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts?.load) return Promise.resolve();
  return Promise.all([
    document.fonts.load(`13px ${GEORGIAN_FAMILY}`, "ა"),
    document.fonts.load(`bold 13px ${GEORGIAN_FAMILY}`, "ა"),
  ]).then(
    () => undefined,
    () => undefined,
  );
}
