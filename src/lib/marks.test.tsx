// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MARKS } from "./sessions";
import { MARK_SHADES, SettingsProvider, THEMES } from "./settings";

// `sessions.test.ts` pins the marks' NAMES. These pin their SHADES, which no
// type can: nothing fails to compile when two of them stop being tellable apart
// — and that is how a green and a teal one tint apart shipped. (That every mark
// HAS a shade in both sets is the one thing the type does hold: `MARK_SHADES`
// is a `Record<Mark, string>` twice over.)

/** The status dot's two colours — `.rail-dot.dot-busy` and `.dot-attention` in
 *  App.css. Copies, because a stylesheet cannot be read from here: vitest hands
 *  a test an empty string for any CSS it imports. Change them together. */
const DOT = { busy: "#89b4fa", "needs you": "#fab387" };

/** sRGB hex → linear-light RGB. */
function linear(hex: string): number[] {
  return [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
}

/** WCAG contrast ratio. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = linear(hex);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** How different two colours LOOK: their distance in OKLab (Ottosson, 2020),
 *  ×100. Equal steps on it are roughly equal steps to the eye, in brightness
 *  and in tint alike — which a difference of hex digits is not. */
function apart(a: string, b: string): number {
  const lab = (hex: string) => {
    const [r, g, bl] = linear(hex);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 100;
}

describe("session mark colours", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  // Green and teal shipped 7 apart on this scale — one brightness, a tint of
  // difference — and were reported as the same mark. 15 is twice that. The dot
  // is held to the same number: a mark that can pass for amber or blue is read
  // as the attention signal, the one thing a marking system must not do.
  it("keeps every mark apart from the others and from the status dot", () => {
    for (const [kind, set] of Object.entries(MARK_SHADES)) {
      const marks = Object.entries(set);
      const others = [...marks, ...Object.entries(DOT)];
      for (const [i, [name, shade]] of marks.entries()) {
        for (const [other, colour] of others.slice(i + 1)) {
          expect(apart(shade, colour), `${kind} set: ${name} against ${other}`).toBeGreaterThanOrEqual(15);
        }
      }
    }
  });

  // 3:1 is WCAG's floor for a graphic that has to be seen (1.4.11); the pastels
  // managed 1.2:1 on the Light theme's rows. Run against the themes themselves,
  // so a new theme is held to it on the day it is added.
  it("stays visible on every row background of every theme", () => {
    for (const theme of THEMES) {
      for (const m of MARKS) {
        for (const row of ["panel", "hover", "selected"]) {
          expect(
            contrast(MARK_SHADES[theme.editor][m], theme.ui[row]),
            `${theme.name}: ${m} on the ${row} background`
          ).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  // The stylesheet names no shade of its own — it draws `var(--mark-*)`, so a
  // set that never reaches the root is a mark that is not drawn at all.
  it("reaches the stylesheet as the set for the theme's kind", () => {
    for (const theme of THEMES) {
      localStorage.setItem("beecork.settings", JSON.stringify({ themeId: theme.id }));
      render(
        <SettingsProvider>
          <i />
        </SettingsProvider>
      );
      for (const m of MARKS) {
        expect(
          document.documentElement.style.getPropertyValue(`--mark-${m}`),
          `${theme.name}: ${m}`
        ).toBe(MARK_SHADES[theme.editor][m]);
      }
      cleanup();
    }
  });
});
