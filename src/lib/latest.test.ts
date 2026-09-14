import { describe, it, expect } from "vitest";
import { createLatestWins } from "./latest";

// The primitive three separate findings now lean on, and it was unpinned.
describe("latest-wins", () => {
  it("drops a reply older than one already applied to the same key", () => {
    const l = createLatestWins();
    const slow = l.take();
    const fast = l.take();
    expect(l.accept("k", fast)).toBe(true);
    expect(l.accept("k", slow)).toBe(false);
  });

  it("accepts replies in order and never the same ticket twice", () => {
    const l = createLatestWins();
    const a = l.take();
    const b = l.take();
    expect(l.accept("k", a)).toBe(true);
    expect(l.accept("k", b)).toBe(true);
    // `>=`, so a double-settle cannot double-paint.
    expect(l.accept("k", b)).toBe(false);
  });

  it("keeps keys independent, which is what makes the batch case work", () => {
    // One `pty_status_all` reply carries many sessions; a later single-session
    // call must not invalidate the whole batch for everyone else.
    const l = createLatestWins();
    const batch = l.take();
    const single = l.take();
    expect(l.accept("s1", single)).toBe(true);
    expect(l.accept("s2", batch)).toBe(true); // untouched by s1's newer ticket
    expect(l.accept("s1", batch)).toBe(false); // but s1 itself is now guarded
  });

  it("forget re-arms one key and leaves the others alone", () => {
    const l = createLatestWins();
    const t = l.take();
    expect(l.accept("gone", t)).toBe(true);
    expect(l.accept("stays", t)).toBe(true);
    l.forget("gone");
    expect(l.accept("gone", t)).toBe(true); // re-armed
    expect(l.accept("stays", t)).toBe(false); // untouched
  });

  // The regression this test file exists for. The 2026-09-14 audit proposed
  // keying the file panel's guard on the repo ROOT. That fix would have been
  // INERT: a stale reply for repo A files under key "A", where no newer ticket
  // has ever landed, so `accept` allows it and A's statuses paint over B's tree.
  // A guard is only a guard at the granularity of the state it protects, and
  // `statuses`/`entries` are one slice describing one current root.
  it("a per-root key would NOT order two different roots — hence the constant key", () => {
    const perRoot = createLatestWins();
    const slowA = perRoot.take();
    const fastB = perRoot.take();
    expect(perRoot.accept("/repo/B", fastB)).toBe(true);
    // A's reply is older, but it is the first under ITS key — so it is accepted,
    // and the stale paint happens anyway. This is the bug, demonstrated.
    expect(perRoot.accept("/repo/A", slowA)).toBe(true);

    const oneSlice = createLatestWins();
    const slowA2 = oneSlice.take();
    const fastB2 = oneSlice.take();
    expect(oneSlice.accept("statuses", fastB2)).toBe(true);
    expect(oneSlice.accept("statuses", slowA2)).toBe(false); // correctly dropped
  });
});
