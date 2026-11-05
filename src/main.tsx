import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { SettingsProvider } from "./lib/settings";
import { installGlobalErrorLog, logPainted } from "./lib/diag";
import { preloadGeorgianFont } from "./lib/fonts";
import "./fonts.css";

// Before the first render, so an error during it is on record too.
installGlobalErrorLog();

// Fire-and-forget: the bundled Georgian face is local, so it's ready long
// before a shell prints anything.
void preloadGeorgianFont();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary what="Beecork Terminal" remountsTerminals>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);

// After render is QUEUED, not awaited: logPainted waits two animation frames, so
// it only writes once a frame has actually been composited. `[ready]` without
// `[painted]` is a window that never drew — see diag.ts.
logPainted();
