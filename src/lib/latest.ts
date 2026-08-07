import { useRef } from "react";

/**
 * "Newest request wins" for overlapping fire-and-forget calls.
 *
 * v0.1.25 moved the heavy Rust commands to `#[tauri::command(async)]` — a real
 * main-thread win, but it silently removed a guarantee nobody had written down.
 * A plain `#[tauri::command]` replied inline, so replies arrived in call order;
 * an async one runs as its own tokio task, so they arrive in COMPLETION order. A
 * slow reply landing after a fresh one then paints stale data: a resurrected
 * `running` label that re-fires the attention chime, or the previous repo's git
 * statuses over the current tree.
 *
 * Take a ticket BEFORE the call; `accept(key, ticket)` returns false at resolve
 * time if a newer ticket already landed for that key.
 *
 * The KEY choice is the whole design. One `pty_status_all` reply carries many
 * sessions, so the key is the SESSION, not the call — a single global epoch
 * would throw away a whole batch's fresh data for every other session just
 * because one single-session call was issued later. With per-session keys the
 * two interleave correctly in both directions: a later single-id reply wins for
 * its own session and leaves the rest of the batch alone, and a later batch wins
 * for everything including that session.
 */
export interface LatestWins {
  /** Take a monotonically increasing ticket for one request. */
  take: () => number;
  /** Claim `key` for `ticket`. False when a newer reply already landed for it. */
  accept: (key: string, ticket: number) => boolean;
  /** Drop a key's bookkeeping (a closed session), so the map can't grow forever. */
  forget: (key: string) => void;
}

export function createLatestWins(): LatestWins {
  let issued = 0;
  const applied = new Map<string, number>();
  return {
    take: () => ++issued,
    // `>=` is safe and strict: tickets are unique per request and a batch claims
    // each of its keys exactly once, so no key ever sees the same ticket twice.
    accept(key, ticket) {
      if ((applied.get(key) ?? 0) >= ticket) return false;
      applied.set(key, ticket);
      return true;
    },
    forget(key) {
      applied.delete(key);
    },
  };
}

/**
 * One `LatestWins` per component instance, stable for its lifetime. Stability
 * matters: this ends up in the dependency array of the 2s status poll's effect,
 * and a fresh object each render would tear the interval down and rebuild it.
 */
export function useLatestWins(): LatestWins {
  const ref = useRef<LatestWins | null>(null);
  if (!ref.current) ref.current = createLatestWins();
  return ref.current;
}
