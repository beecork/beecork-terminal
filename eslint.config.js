import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// Deliberately narrow. `tsconfig.json` is already strict — `strict`,
// `noUnusedLocals`, `noUnusedParameters` — so the type checker already catches
// dead variables and type errors, and duplicating that here would only produce
// two voices saying the same thing.
//
// What ESLint adds that `tsc` structurally cannot is the React hooks rules, and
// this is a codebase full of the pattern they exist to protect: effects that
// close over refs, callbacks kept stable with `useCallback`, subscriptions with
// `[]` deps. `exhaustive-deps` is the rule that catches a stale closure before it
// becomes a "why is my terminal writing to the wrong session" bug.
//
// It is a WARNING, not an error, and that is on purpose: several deps here are
// omitted deliberately (see the comments at each `}, [])`). The warning is a
// prompt to write down why, not an order to add the dep — adding it blindly is
// how you get a subscription that tears down on every render.
export default tseslint.config(
  { ignores: ["dist", "src-tauri/target", "site", "node_modules"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,

      // `tsc` already reports these, with better messages and no false positives
      // on type-only usage. Off here so one finding isn't reported twice.
      "@typescript-eslint/no-unused-vars": "off",

      // OFF, deliberately — not "we couldn't be bothered".
      //
      // This rule objects to `someRef.current = latestValue` in a render body.
      // That pattern is load-bearing here and used ~18 times: it is how a
      // long-lived subscription (the pty output channel, a window keydown
      // listener, a ResizeObserver) reads the CURRENT props without being torn
      // down and rebuilt on every render. Rebuilding those is not a style
      // question — recreating the xterm mount effect per render would destroy
      // and respawn the terminal.
      //
      // The alternative React suggests (assign inside an effect) makes the ref
      // stale for the whole render pass, which is worse for the timer- and
      // event-driven readers here, and would mean rewriting the most delicate
      // machinery in the app to satisfy a linter. Every one of these sites is
      // commented with what it is for. If React ships `useEffectEvent`, that's
      // the migration — until then this rule reports a decision, not a defect.
      "react-hooks/refs": "off",

      // WARN, not error. Sometimes a synchronous setState in an effect is the
      // honest way to react to something outside React (a restored session
      // disappearing, a file finishing its load), and sometimes it means state
      // that should have been derived. Worth a look each time; not worth
      // blocking a build.
      "react-hooks/set-state-in-effect": "warn",

      // An empty catch is the house style for "this is best-effort and must
      // never break the UI" (clipboard, sound, a pty write to a closed pane).
      // Every one of them carries a comment saying so.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  }
);
