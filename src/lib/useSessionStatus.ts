import { useCallback, useEffect, useRef, useState } from "react";
import { getRoot, ptyStatus, ptyStatusAll, type PtyStatus } from "./api";
import { wantsAttention, displayName, RESUMABLE_AGENTS, type Session } from "./sessions";
import { notify } from "./notify";
import { useLatestWins } from "./latest";
import * as sound from "./sound";

// Output must pause at least this long for the busy dot to turn off.
const QUIET_MS = 1500;
// …but inferring "needs you" from silence takes much longer. An agent stalls
// output mid-turn all the time — API latency between tool rounds, a silent tool
// run, its event loop blocked on a big result — easily past QUIET_MS while still
// working. Flagging at QUIET_MS lit tabs amber and chimed in the MIDDLE of turns
// (then output resumed, cleared it, and the next stall chimed again). Only a
// pause this long reads as "finished / waiting for you".
const ATTN_QUIET_MS = 6000;
// The just-ended output streak must have lasted at least this long to count
// as a real turn of work worth a "come look". Below it, the burst was a stray
// redraw (a spinner tick, a clock/statusline repaint) — nagging on those lit up
// every quiet background agent in amber at once and drowned the real signal.
const WORK_MIN_MS = 2500;
// A quiet-INFERRED "needs you" that got disproven (output resumed) must not
// chime again right away — at most one inferred chime per session per this
// window. The amber dot still lights; only the repeat sound is suppressed.
// Precise signals (bell, command exit) are exempt and always chime.
const INFER_RECHIME_MS = 60_000;
// Slack allowed between when a quiet timer was due and when it actually ran.
// Beyond this the app was SUSPENDED, not merely busy: macOS freezes a
// backgrounded / minimised / display-asleep window's timers and releases them all
// at once when you come back, so a 1.5s timer can fire hours late.
const STALE_TIMER_MS = 5000;
// How often the batched status poll runs.
const POLL_MS = 2000;
// …and how many of those ticks also resolve each running agent's conversation
// id. That lookup reads the filesystem, and its only consumer is the persisted
// layout (so a relaunch reopens THIS tab's chat) — it needs to be current by the
// time you quit, not every tick. 15 ticks ≈ every 30s.
const AGENT_EVERY = 15;
// …but the moment an agent STARTS is the one time that slow cadence hurts: start
// Claude, quit inside 30 seconds, and the tab never captured a conversation id,
// so the restored session falls back to the generic `--continue` and reopens
// whichever chat ran last — exactly the failure per-tab resume exists to
// prevent. One lookup at the transition isn't enough either: a just-started
// agent hasn't registered yet (Claude writes `~/.claude/sessions/<pid>.json`
// seconds after starting; see agents.rs), so the first few come back empty.
// Grant a short window of eager ticks instead, ended early once every running
// agent has its id.
const AGENT_EAGER_TICKS = 15;

/**
 * Did this timer fire so late that the app must have been suspended in between?
 *
 * The quiet inference is a statement about the RECENT past — "output stopped
 * ATTN_QUIET_MS ago, so the agent is finished and waiting for you". A suspension
 * invalidates it twice over: the silence it measured is just the app being
 * frozen, and any output that did arrive is still sitting in the channel, about
 * to flush the moment we resume. Acting on it lights the amber dot and chimes for
 * a turn that ended hours ago, which reads as the tab going off at random.
 *
 * So when a quiet timer comes back from the dead, drop the inference and let the
 * queued output re-arm it. Nothing real is lost: the two PRECISE producers — a
 * bell, and a command going running → idle — are untouched, and both still fire
 * on resume if that is what actually happened.
 */
function firedLate(armedAt: number, delayMs: number): boolean {
  return Date.now() - armedAt > delayMs + STALE_TIMER_MS;
}

function addId(set: Set<string>, id: string): Set<string> {
  if (set.has(id)) return set;
  const n = new Set(set);
  n.add(id);
  return n;
}
function delId(set: Set<string>, id: string): Set<string> {
  if (!set.has(id)) return set;
  const n = new Set(set);
  n.delete(id);
  return n;
}

/**
 * Owns the per-session cwd / running-command / attention-dot state machine that
 * used to live inline in App: the `terminalCwd` shown in the title bar, the
 * `wantsYou` set behind the blinking dots, and the polling that keeps them fresh
 * (a 2s batched poll, an immediate refresh on session switch, and an on-demand
 * hint after output settles). Writes back into the session list via setCwd /
 * setRunning. Returns the callbacks TerminalPane/App wire up.
 */
export function useSessionStatus(
  sessions: Session[],
  activeId: string,
  visibleIds: string[],
  setCwd: (id: string, cwd: string) => void,
  setRunning: (id: string, running: string | undefined) => void,
  setAgentId: (id: string, agentId: string | undefined) => void,
  /** the user's configured startup folder — the honest seed for the folder view */
  defaultCwd?: string
) {
  const [terminalCwd, setTerminalCwd] = useState<string | null>(null);
  const [wantsYou, setWantsYou] = useState<Set<string>>(() => new Set());
  // Sessions producing output right now — the busy dot. Output activity reflects
  // an agent actually working, which the OS foreground check can't see (a TUI
  // agent is "running" the whole time it's open, working or waiting).
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const idleTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Second-stage timers: armed when the busy dot goes off, fire when the silence
  // has lasted ATTN_QUIET_MS total — only then does a session read as "needs you".
  const attnTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // When each session's current output streak began — so the quiet-timer can tell
  // a real turn of work (worth a "needs you") from a one-frame redraw.
  const busySince = useRef<Record<string, number>>({});
  // Last time each session chimed off a quiet-inferred flag (rate-limits repeats).
  const inferredChimeAt = useRef<Record<string, number>>({});
  const prevRunning = useRef<Record<string, string | undefined>>({});
  // Mirror of wantsYou, so flag/clear can decide-and-chime synchronously instead
  // of inside a setState updater (which must stay side-effect free).
  const wantsRef = useRef<Set<string>>(new Set());

  // Guards against a slow status reply overwriting a fresher one — see latest.ts.
  const latest = useLatestWins();
  // Remaining eager agent-id ticks (see AGENT_EAGER_TICKS). One counter, not a
  // per-session map: nothing to leak, and markClosed needs no extra cleanup.
  const agentEager = useRef(0);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  // The sessions on screen right now (both panes in split, else the focused one).
  // Attention keys off *visibility*, not focus — a pane you can see is "seen".
  const visibleIdsRef = useRef(visibleIds);
  visibleIdsRef.current = visibleIds;
  // Sessions with an unacknowledged bell — the agent's explicit "I need you".
  // Bell-set attention is sticky (only onSeen clears it); attention *inferred*
  // from output going quiet is a proxy that self-clears when output resumes.
  const bellRang = useRef<Set<string>>(new Set());

  const clearWants = useCallback((id: string) => {
    const next = delId(wantsRef.current, id);
    if (next === wantsRef.current) return;
    wantsRef.current = next;
    setWantsYou(next);
  }, []);

  // Flag a session as needing you, chiming once at the moment it newly flips.
  // Precise producers (bell, command exit) always chime; the quiet-inferred
  // proxy rate-limits its chime so a session that flaps (stall → flag → output
  // resumes → clear → stall…) can't keep calling you. The dot always lights.
  const flagWants = useCallback((id: string, inferred: boolean) => {
    if (wantsRef.current.has(id)) return;
    const now = performance.now();
    // Decide the chime (and stamp the rate limit only when it will really sound),
    // then light the dot, and only THEN make noise. Sound is best-effort and the
    // flag is not: a throwing sound call must never cost the user their "needs
    // you" dot and OS notification — the same rule the bell path in TerminalPane
    // spells out. This was the last site where the order was still the other way.
    const chime =
      !inferred || now - (inferredChimeAt.current[id] ?? -Infinity) >= INFER_RECHIME_MS;
    if (chime && inferred) inferredChimeAt.current[id] = now;
    wantsRef.current = addId(wantsRef.current, id);
    setWantsYou(wantsRef.current);
    if (chime) {
      // The chime goes last so a throw can't cost the dot — and it is wrapped
      // because onBell still has work AFTER this returns (the OS notification at
      // the bottom of onBell), which a throw would skip. Not a React mechanism:
      // React 19 queues its flush as a microtask and a later throw cannot cancel
      // it. sound.ts is fire-and-forget and cannot throw today; it was
      // synchronous Web Audio until v0.1.15.
      try {
        sound.attention();
      } catch {
        /* never let audio cost the user their notification */
      }
    }
  }, []);

  const applyCwd = useCallback(
    (id: string, cwd: string) => {
      setCwd(id, cwd);
      if (id === activeIdRef.current) {
        setTerminalCwd((prev) => (prev === cwd ? prev : cwd));
      }
    },
    [setCwd]
  );

  const applyStatus = useCallback(
    (id: string, st: PtyStatus, ticket: number) => {
      // Drop late responses for a session that's already closed (else a stale
      // {running:null} could re-flag a gone session as "wants you").
      if (!sessionsRef.current.some((s) => s.id === id)) return;
      // …and drop one that a newer reply for THIS session already overtook. The
      // status commands are async now, so completion order is not call order.
      if (!latest.accept(id, ticket)) return;
      if (st.cwd) applyCwd(id, st.cwd);
      // A tick that could not READ the foreground command answers `running: null`
      // — the same shape as "the shell is idle at its prompt", and the opposite
      // meaning. Acting on it announces a completion that never happened: amber
      // dot + chime on a session whose agent is still sitting there, and it
      // clears the agent id that "Resume" needs. Hold everything running-related
      // and let the next tick (2s) answer for real. See running_known in pty.rs.
      if (st.running_known === false) return;
      const nowRunning = st.running ?? undefined;
      const was = prevRunning.current[id];
      // Two producers feed wantsYou, deliberately complementary: this process-
      // detection path catches a *silent* background command finishing
      // (running→idle) — the one case output-activity misses — while onActivity's
      // quiet-timer catches TUI agents (always the tty's foreground process). A
      // session on screen (visible in either split pane) counts as seen, so a pane
      // you can see never nags.
      if (wantsAttention(was, nowRunning, visibleIdsRef.current.includes(id))) {
        flagWants(id, false); // a command really exited — precise, always chimes
      }
      // An agent just started — resolve its conversation id promptly rather than
      // waiting up to 30s for the next slow tick. Gated to the agents the backend
      // can actually resolve, or a `vim` tab would arm this forever.
      if (!was && nowRunning && RESUMABLE_AGENTS.has(nowRunning)) {
        agentEager.current = AGENT_EAGER_TICKS;
      }
      prevRunning.current[id] = nowRunning;
      setRunning(id, nowRunning);
      // Pin the running agent's conversation id. When the agent exits (running →
      // idle) clear it too; while it runs but a single poll fails to resolve the
      // id (Claude closes its transcript between writes), keep the last known one
      // rather than flapping it to nothing.
      const agentId = st.agent_session ?? undefined;
      if (agentId || !nowRunning) setAgentId(id, agentId);
    },
    [applyCwd, setRunning, setAgentId, flagWants, latest]
  );

  const onCwd = useCallback((id: string, path: string) => applyCwd(id, path), [applyCwd]);

  const onStatusHint = useCallback(
    (id: string) => {
      if (id !== activeIdRef.current) return;
      const ticket = latest.take();
      ptyStatus(id).then((st) => applyStatus(id, st, ticket)).catch(() => {});
    },
    [applyStatus, latest]
  );

  // Every output chunk marks the session busy and (re)arms the quiet timers.
  // Stage one (QUIET_MS): the busy dot turns off. Stage two (ATTN_QUIET_MS
  // total): if the session is STILL silent and off-screen, the ended streak
  // becomes a "come look". The long confirmation window is what separates a
  // finished turn from a mid-turn stall (API latency, a silent tool run), which
  // used to flag-and-chime while the agent was still working. Resumed output
  // disproves a quiet-inferred "come look", so clear it here — unless a bell
  // rang (a real "I need you" that waits until you look).
  const onActivity = useCallback(
    (id: string) => {
      const now = performance.now();
      // The streak start is recorded OUTSIDE the updater. React requires
      // updaters to be pure and StrictMode double-invokes them to surface it: on
      // a replay `prev.has(id)` is false again, so the start time would be
      // overwritten with the latest chunk's timestamp, collapsing `workedMs`
      // toward zero and suppressing the quiet-inferred "come look" for a turn
      // that genuinely qualified. `busySince[id] === undefined` is the same
      // "streak already running?" question `prev.has(id)` asks — the two stay in
      // lockstep because every `setBusy` that removes an id deletes the key in
      // the same breath (the idle timer below, and `markClosed`).
      if (busySince.current[id] === undefined) {
        busySince.current[id] = now; // idle → working: a fresh streak begins
      }
      setBusy((prev) => (prev.has(id) ? prev : addId(prev, id)));
      if (!bellRang.current.has(id)) clearWants(id);
      clearTimeout(idleTimers.current[id]);
      clearTimeout(attnTimers.current[id]);
      delete attnTimers.current[id];
      const armedAt = Date.now();
      idleTimers.current[id] = setTimeout(() => {
        const workedMs = now - (busySince.current[id] ?? now);
        delete busySince.current[id];
        setBusy((prev) => delId(prev, id));
        // Came back from a suspension — the silence below is an artifact of the
        // app being frozen, not of the agent finishing. See firedLate.
        if (firedLate(armedAt, QUIET_MS)) return;
        // Only nag when a *real* turn of work ended. A brief blip (spinner tick,
        // statusline repaint) isn't a completion, so it must never flip an idle
        // background agent to blinking amber. Genuine "come look" signals — a
        // bell, or a foreground command going running→idle — come from the other
        // two producers and are unaffected by this gate. Visibility is checked
        // when the timer FIRES: a pane you can see never nags.
        if (workedMs >= WORK_MIN_MS) {
          const attnArmedAt = Date.now();
          attnTimers.current[id] = setTimeout(() => {
            delete attnTimers.current[id];
            // …and again for a suspension that began inside THIS window, after
            // the busy dot went off but before the quiet window completed.
            if (firedLate(attnArmedAt, ATTN_QUIET_MS - QUIET_MS)) return;
            if (!visibleIdsRef.current.includes(id)) flagWants(id, true);
          }, ATTN_QUIET_MS - QUIET_MS);
        }
      }, QUIET_MS);
    },
    [clearWants, flagWants]
  );

  // The bell is the agent's explicit "I need you" — the precise attention signal.
  // No nag for a session already on screen; a bell stays sticky until onSeen.
  const onBell = useCallback(
    (id: string) => {
      if (visibleIdsRef.current.includes(id)) return;
      bellRang.current.add(id);
      flagWants(id, false); // explicit "I need you" — precise, always chimes
      // If you're in another app, ping the OS so you don't miss it.
      if (!document.hasFocus()) {
        const s = sessionsRef.current.find((x) => x.id === id);
        notify(`${s ? displayName(s) : "A session"} needs you`, "Your agent is waiting for you.");
      }
    },
    [flagWants]
  );

  const onSeen = useCallback(
    (id: string) => {
      bellRang.current.delete(id);
      clearWants(id);
    },
    [clearWants]
  );

  // Forget a closed session so nothing leaks or resurrects its id.
  const markClosed = useCallback(
    (id: string) => {
      delete prevRunning.current[id];
      delete busySince.current[id];
      delete inferredChimeAt.current[id];
      clearTimeout(idleTimers.current[id]);
      delete idleTimers.current[id];
      clearTimeout(attnTimers.current[id]);
      delete attnTimers.current[id];
      bellRang.current.delete(id);
      latest.forget(id);
      clearWants(id);
      setBusy((prev) => delId(prev, id));
    },
    [clearWants, latest]
  );

  // Seed the folder view before the first status poll lands. Prefer the user's
  // configured default folder; `get_root()` is only a last resort, because it is
  // the APP PROCESS's cwd — `/` for a Finder-launched .app, which would root the
  // file tree at the whole filesystem. Seeding never OVERWRITES a cwd we already
  // know: the async resolve used to land after the restore below and clobber a
  // restored session's folder with the process cwd.
  useEffect(() => {
    let cancelled = false;
    const seed = (p: string) => {
      if (!cancelled && p) setTerminalCwd((prev) => prev ?? p);
    };
    if (defaultCwd) seed(defaultCwd);
    else getRoot().then(seed).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [defaultCwd]);

  // Immediate status on session switch.
  useEffect(() => {
    const known = sessionsRef.current.find((s) => s.id === activeId)?.cwd;
    if (known) setTerminalCwd(known);
    const ticket = latest.take();
    ptyStatus(activeId).then((st) => applyStatus(activeId, st, ticket)).catch(() => {});
  }, [activeId, applyStatus, latest]);

  // Poll every session for cwd + running command — one batched call per tick.
  //
  // This deliberately keeps running when the window is hidden. It looks like an
  // obvious thing to pause, but a hidden window is exactly when this poll earns
  // its keep: it is the ONLY producer that notices a silent background command
  // finishing (running → idle), which is the "come look, it's done" signal you
  // most want while you're in another app. What *is* skipped is the expensive
  // half — see AGENT_EVERY.
  useEffect(() => {
    let tick = 0;
    const t = setInterval(() => {
      const ids = sessionsRef.current.map((s) => s.id);
      if (!ids.length) return;
      // Resolving each agent's conversation id costs a transcript-directory scan
      // (and sometimes an `lsof`) per running agent. Its only consumer is the
      // persisted layout, so it has to be current by the time you QUIT — not
      // twice a second. Ask on the first tick, then every AGENT_EVERY ticks.
      // Stop resolving eagerly as soon as every running agent has its id.
      if (
        agentEager.current > 0 &&
        !sessionsRef.current.some(
          (s) => s.running && RESUMABLE_AGENTS.has(s.running) && !s.agentId
        )
      ) {
        agentEager.current = 0;
      }
      const withAgents = tick % AGENT_EVERY === 0 || agentEager.current > 0;
      if (agentEager.current > 0) agentEager.current--;
      tick++;
      // ONE ticket for the whole batch, claimed per session id inside applyStatus.
      const ticket = latest.take();
      ptyStatusAll(ids, withAgents)
        .then((map) => {
          for (const [id, st] of Object.entries(map)) applyStatus(id, st, ticket);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
    // `latest` is stable for the hook's lifetime (a lazy ref), so listing it
    // cannot restart the interval — which it must not, or the poll would reset
    // on every render.
  }, [applyStatus, latest]);

  return { terminalCwd, wantsYou, busy, onCwd, onStatusHint, onActivity, onBell, onSeen, markClosed };
}
