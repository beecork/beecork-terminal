# What to build next — Beecork Terminal

**Status:** Draft. The owner asked for an honest prioritization ("why not fix all the
cons and add all the features — what's really worth doing?"). The top-line goal question
was posed but not yet answered; this brief proceeds on the **recommended** path ("make it
THE place to run agents") and flags it as pending confirmation.

**Date:** 2026-07-04 · after shipping v0.1.4.

---

## The one-line judgment

Beecork's single real differentiator is **controlling the agent's changes, not just
watching them.** The diff view already *shows* what the agent edited; the missing 20% is
the *control* — accept / revert / commit from the panel without dropping to the terminal.
That's the bet worth making. Everything else on the list is either table-stakes
(persistence) or polish (palette, grids, Windows parity) — worth doing, but it won't be
why anyone chooses Beecork.

**Why not "do everything":** eight half-features make a slightly nicer terminal; one deep
feature makes a product people switch to. Scattering the next cycle across the whole list
spends the effort where it least changes the outcome.

---

## How it is now (verified in code, not memory)

- **The diff view is read-only.** `src-tauri/src/git.rs` exposes only `git_status` and
  `git_file_original` (git `status` / `show` / `rev-parse` / `cat-file`). There is **no**
  `add` / `commit` / `checkout` / `restore` command, and `lib.rs`'s invoke handler
  registers no git-write command. So you can *see* the agent's edits (tree coloring +
  line-level diff vs HEAD) but can only act on them by typing git in the terminal.
- **Sessions are in-memory only.** `src/lib/sessions.ts` (`useSessions`) holds the session
  list in React state; nothing writes it to disk. Layout prefs (rail expanded, split %,
  panel layout, tree size) persist via `usePersistedState`, but session identities, names,
  cwds, and the split pairing do **not**. Quit the app → they're gone.
- **Attention is a heuristic.** `src/lib/useSessionStatus.ts` infers "working" from output
  activity and "needs you" from the terminal bell (or going quiet after working). Good, but
  not a guarantee — it depends on the agent ringing the bell.

*What already works and we'd keep:* the diff view is genuinely useful as-is; the git backend
is hardened against racing/hostile repos; the attention dots + notifications already make
parallel supervision feasible. None of this gets thrown away — the bet *extends* the diff view.

---

## The prioritization (honest tiers)

### Tier 1 — agent change-review — REFRAMED by the owner (2026-07-04)
Owner's steer: most Beecork users (including the owner) **trust the agent** and do not want to
approve every change. Plus a hard technical truth: the agent writes files **directly to disk**
through the terminal, so Beecork sees changes *after the fact* and **cannot hold a change
"pending approval."** The only real action is **Undo (revert)**; "approve" could only mean
"I've seen it." So "undo, not approve" is the honest design, not just the simpler one.

Refined design:
- **Default — trust mode (OFF):** no gate, zero friction. The diff view shows changes as it does
  today, plus a per-file **Undo** (revert that file to its last-committed state) for when you
  spot a bad edit. You never "approve" anything.
- **Advanced — review mode (an OBVIOUS toggle, not buried in settings):** turns the diff into a
  review checklist — each changed file is "needs review" until you **Approve** (mark seen /
  clear it) or **Revert**. For users less confident in the agent.
- Undo = revert to HEAD (last commit). Caveat to surface in the confirm: that discards *all*
  uncommitted edits to that file — the agent's and any of yours — which is fine for the
  trust-the-agent flow but must be stated.

**Open scope question (below):** since even the owner wouldn't use the review-gate, v1 may be
*just the Undo button* — ~80% of the value for ~20% of the work — deferring the advanced review
toggle until users ask for it. No terminal or IDE gives even the simple Undo.

### Tier 2 — trust floor: session persistence + agent resume
Reopen the app to your sessions, names, cwds, and split layout. Table-stakes for something
branded a "cockpit," and likely the first thing a returning user misses.
- **Owner's key refinement (2026-07-04): resume the AGENT, not just the shell.** Beecork
  already detects which agent each session runs (`classify_command` → "claude"/"codex"/…).
  On restore, re-spawn the shell in the saved cwd and offer/auto-run that agent's resume
  command (e.g. `claude --continue` / `--resume`, Codex equivalent) so the *conversation*
  comes back, not just an empty prompt. This is what turns persistence from "nice" into
  "genuinely picks up where I left off."
- **Honest limit:** we don't literally revive the old process — we re-run the tool's own
  resume command, so it only works for agents that support resume (Claude Code does well).
  A plain shell with no agent just restores its directory. The UI should make the state clear.
**A few days** for shell + layout restore; a bit more for the resume wiring. Low risk, high
perceived value. Confirmed as the **first** build.

### Tier 3 — sharpen the headline: precise attention protocol
Make "needs you" truthful instead of inferred: define a tiny escape sequence / marker an
agent can emit ("need input" / "done" / "error"), and ship an optional Claude Code hook that
emits it. Upgrades the amber dot from a good guess to a guarantee; the current heuristic
stays as the fallback for tools that don't emit it. **Medium**, high polish value, depends
on agent cooperation.

### Tier 4 — polish, explicitly deferred (say no for now)
Clickable notifications (cheap — do opportunistically when touching notify), command palette,
split grids (3–4 panes), named workspaces, Windows foreground detection, bundle-size worry
(already lazy-loaded, fine). Nice, none differentiating. The 2 upstream quick-xml advisories
and the app-global watcher are known/documented and not worth a cycle.

---

## Recommended sequence

1. **Session persistence** (Tier 2) — fast, low-risk, removes the worst gap, ships in a
   release quickly, and makes the app feel "real."
2. **Agent change-review** (Tier 1) — the marquee; the reason to choose Beecork.
3. **Attention protocol** (Tier 3) — a polish pass that makes the existing headline feature
   trustworthy.

Rationale for persistence-first: it's the cheap credibility win that de-risks and builds
momentum before the multi-week bet. It is *not* the differentiator and shouldn't be sold as one.

---

## Risks / new problems introduced

- **Change-review writes to the user's repo** — the biggest new risk surface. A bad revert
  loses the user's *or the agent's* work. Requires: confirm-before-revert UX, never
  auto-commit, and it must go through the hardened `git()` helper so it doesn't race the
  agent's own git in the terminal. This is where the care goes.
- **Persistence edge cases** — a restored session whose cwd no longer exists (already have a
  fallback pattern from the pty spawn-retry fix); the "process isn't actually running"
  confusion (mitigate with explicit UI copy).
- **Attention protocol** needs agent cooperation; keep the heuristic fallback.

## Decision / next step  (finalized 2026-07-04)

**Sequence (updated 2026-07-04):** (1) session persistence + agent resume ✅ **done** →
(2) attention-protocol polish (optional, later). **Change-review: DROPPED.**

**Change-review — DROPPED (2026-07-04).** The owner was doubting it and cut it entirely rather
than leave it half-considered. The reasoning that held up: the owner and most users **trust the
agent**, so an approve/undo layer is friction they wouldn't use — and it was the riskiest item
(writes to the repo). It was **never started**, so there is no code to remove. Revisit only if
less-confident users ask for it.

**Build order:**
1. **Session persistence + resume** — ✅ DONE (shipping in v0.1.5).
2. **Attention protocol** — optional polish, later.

### Session-persistence plan (build #1)
- **Persist** (to `localStorage`, via the existing `usePersistedState`/`persist.ts` pattern):
  each session's name/custom, cwd, startCwd, partner (split pairing), and the detected running
  agent; plus the active session id. Save on change (debounced).
- **Restore on launch:** rebuild the session list + split layout; each `TerminalPane` already
  re-spawns its shell in `startCwd`/`lastCwd`, so shells come back in the right folders.
- **Resume the agent:** for a session whose saved running-agent was e.g. `claude`, surface a
  one-click **Resume** affordance (or a dim prompt) that runs `claude --continue` in that pane.
  UX fork to confirm with owner: auto-run on restore vs. one-click prompt (lean: prompt, so we
  never fire a command the user didn't ask for).
- **Honest state in UI:** a restored session that isn't actively running an agent should look
  distinct from a live one (avoid the old "restored session" confusion).

**Progress (2026-07-04):**
- ✅ **Core persist/restore built** (`src/lib/sessions.ts`): `useSessions` now saves the layout
  (id, name, custom, cwd, partner/split, active session, + the running agent) to `localStorage`
  on change, and restores it on launch (shells re-open in their saved cwds via `startCwd`).
  Typechecks; 31/31 existing tests pass. Behavior best confirmed by relaunching the app.
- ✅ **Resume affordance built** (one-click, chosen on best judgment while owner away —
  confirm/flip to auto later). A restored session that was running an agent shows a
  **"⟳ Resume claude"** pill (`term-resume`); clicking it runs `claude --continue` (or
  `codex resume`, else `<agent> --continue` — `resumeCommand()` in sessions.ts, unit-tested)
  in that pane. The pill dismisses when used OR when you start typing your own command.
  Files: sessions.ts (`resumeAgent`, `resumeCommand`, `clearResume`), TerminalPane.tsx,
  App.tsx, App.css. tsc clean; 33/33 tests. **Test by quitting + reopening the app.**
- ⏳ Minor follow-ups (not blocking): distinct "restored" visual state; dead-cwd fallback
  (a saved cwd since deleted currently shows the retryable spawn-error; could fall back to
  root). Feature #1 is otherwise done.

**Feature #1 status: DONE (uncommitted).** Next: change-review v1 = the Undo button — gets a
short plan before the repo-writing revert code lands.
