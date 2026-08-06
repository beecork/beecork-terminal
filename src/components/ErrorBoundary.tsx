import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** what broke, in the user's terms — e.g. "The file panel" */
  what: string;
  /** render inline (inside a panel) instead of as a full-window card */
  inline?: boolean;
}

interface State {
  error: Error | null;
}

/**
 * Catches a render/lifecycle throw so it doesn't blank the window.
 *
 * This matters more here than in a normal app: the shells live in Rust and keep
 * running regardless, so a React crash would leave you staring at a white
 * rectangle while your agents worked on invisibly. Two placements:
 *
 *   • around the file panel — by far the likeliest thrower, since it renders
 *     arbitrary file content through CodeMirror — so a bad file can't take the
 *     terminal down with it;
 *   • around the whole app, as the last resort.
 *
 * "Try again" simply re-renders, which fully recovers from a transient bad
 * state and keeps every shell attached. Reloading is the bigger hammer, and the
 * label says what it costs: the webview restarts, so the shells are respawned.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.what} crashed`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className={`crash${this.props.inline ? " inline" : ""}`}>
        <div className="crash-card">
          <div className="crash-title">{this.props.what} stopped working.</div>
          <div className="crash-msg">{error.message || String(error)}</div>
          <div className="crash-actions">
            <button className="btn primary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button className="btn ghost" onClick={() => window.location.reload()}>
              Reload window
            </button>
          </div>
          <div className="crash-note">
            Reloading restarts the webview, so each session opens a fresh shell.
          </div>
        </div>
      </div>
    );
  }
}
