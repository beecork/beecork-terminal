# Releasing Beecork Terminal

How this app auto-publishes for macOS, Windows, and Linux — modeled on how
CozyPane ships, but adapted for **Tauri** (CozyPane is Electron).

The model in one line: **push a `vX.Y.Z` git tag → GitHub Actions builds every
platform, signs+notarizes macOS, and publishes a GitHub Release. The website
reads that release and points its download buttons at the assets.**

Everything below marked **[you]** needs a human (secrets, creating the repo,
touching the live site). Everything else is already wired in this repo.

---

## What's already in this repo

| File | Purpose |
|---|---|
| `.github/workflows/release.yml` | Matrix build (mac arm64+x64, Windows, Linux) via `tauri-apps/tauri-action`, publishes a GitHub Release on tag `v*`. |
| `src-tauri/tauri.conf.json` | Release-ready bundle metadata (product name, publisher, category, icons, targets `all`). |
| `site/terminal/index.html` | The `beecork.com/terminal/` download page — static links to the **stable-named** assets (below), the GitHub API only adds the version label. **Copy to the beecork-site repo** (see below). |
| `.github/workflows/linux-smoke.yml` | On-demand: launches a published Linux build on Ubuntu 22.04/24.04 under Xvfb (AppImage and .deb), checks it stays up and logged no panic, attaches a screenshot. The only Linux desktop we have. |

---

## One-time setup

### 1. Create the GitHub repo **[you]**

```bash
cd /Users/apple/Coding/Beecork/beecrok-terminal
git add -A
git commit -m "Beecork Terminal"
gh repo create beecork/beecork-terminal --public --source=. --remote=origin \
  --description "A desktop cockpit for CLI coding agents — terminal + live diff + file browser." \
  --push
```

### 2. Add GitHub Actions secrets (macOS signing) **[you]**

These reuse your **existing CozyPane Apple identity (team `X3F4527AS7`)** — same
Apple Developer account, same certificate. `tauri-action` uses different secret
*names* than CozyPane's electron-builder, so here's the mapping. Source values
live in **CozyKey** (GitHub secrets are write-only, so copy from there, not from
the CozyPane repo).

| New secret (this repo) | Same value as CozyPane's… | Notes |
|---|---|---|
| `APPLE_CERTIFICATE` | `MAC_CSC_LINK` | base64 of the `.p12` (Developer ID Application cert) |
| `APPLE_CERTIFICATE_PASSWORD` | `MAC_CSC_KEY_PASSWORD` | password for the `.p12` |
| `APPLE_ID` | `APPLE_ID` | your Apple ID email |
| `APPLE_PASSWORD` | `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password |
| `APPLE_TEAM_ID` | `APPLE_TEAM_ID` | `X3F4527AS7` |
| `APPLE_SIGNING_IDENTITY` | *(new)* | `Developer ID Application: <Your Name> (X3F4527AS7)` |

Find the exact `APPLE_SIGNING_IDENTITY` string:
```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

Add each secret:
```bash
gh secret set APPLE_CERTIFICATE --repo beecork/beecork-terminal < cert.b64
gh secret set APPLE_CERTIFICATE_PASSWORD --repo beecork/beecork-terminal
# …repeat for the rest
```

> **Skip signing?** If you push a tag *without* these secrets, the build still
> succeeds and publishes **unsigned** mac builds. Users then right-click → Open
> to bypass Gatekeeper once. Add the secrets whenever you're ready for a clean
> install experience — no code change needed.

### 3. Auto-update signing key — **already wired** ⚠️

Auto-update **is fully wired** — `tauri-plugin-updater` is registered in
`src-tauri/src/lib.rs`, `tauri.conf.json` has `plugins.updater` (endpoint +
public key) and `bundle.createUpdaterArtifacts: true`, and the app shows an
"Install & Restart" banner (`UpdateBanner.tsx`). The build signs the update
manifest with the **existing** signing key.

> **DO NOT regenerate the updater key.** The public key baked into
> `tauri.conf.json` must match the private key already in the repo secrets and
> in every installed copy. Generating a new key would make all existing
> installs reject future updates (signature mismatch). The current private key
> + password live in **CozyKey** as `TAURI_SIGNING_PRIVATE_KEY` /
> `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` and are already set as repo secrets.

---

## Cutting a release

```bash
# bump the version in ALL FOUR: package.json, src-tauri/tauri.conf.json,
# src-tauri/Cargo.toml, and src-tauri/Cargo.lock (the [[package]] name =
# "beecork-terminal" entry — keep the lockfile in sync or the build tree is dirty)
git commit -am "v0.1.0"
git tag -a v0.1.0 -m "v0.1.0"   # MUST be annotated (-a); see note below
git push --follow-tags
```

> ⚠️ **The tag must be annotated (`-a`).** `git push --follow-tags` pushes *only*
> annotated tags, so a lightweight `git tag v0.1.0` would push `main` but silently
> leave the tag behind — and since the build triggers on the **tag** reaching
> GitHub, nothing would build. If you ever end up with a lightweight tag, push it
> explicitly instead: `git push origin v0.1.0`.

> ⚠️ **A tag push can be badly delayed — dispatch instead of waiting.**
> Observed on v0.1.25 (2026-08-06): the tag reached GitHub and no run appeared for
> many minutes, on two separate pushes. (Corrected on v0.1.26: those push runs DID
> eventually arrive, ~20 minutes late. So the trigger is not broken, it is
> unreliable — and on v0.1.26 it fired promptly, producing a SECOND run racing the
> dispatched one. Cancel one if that happens; prefer keeping the dispatched run,
> since v0.1.24's push-triggered run is the one that failed to publish.)
>
> **So after pushing the tag, don't wait — run:**
> ```bash
> gh workflow run release.yml --ref v0.1.25   # the TAG, not main
> gh run watch $(gh api "repos/beecork/beecork-terminal/actions/runs?per_page=1" --jq '.workflow_runs[0].id')
> ```
> `--ref <tag>` matters: the version-consistency check only runs on a tag ref, and
> `tauri-action` reads the version from the checked-out tree.
>
> **Then confirm the release actually published** — don't assume a green run means
> a shipped release:
> ```bash
> gh release view v0.1.25 --json assets --jq '.assets[].name'
> ```
> This is not paranoia: **v0.1.24 built and then failed to publish**, so no release
> for it exists and nobody ever received it. Its Windows job died on
> `Resource not accessible by integration` from the create-a-release API. Note that
> the org enforces `default_workflow_permissions: read` and repos cannot override it
> (`PUT .../actions/permissions/workflow` returns 409, "Write permissions for
> workflows are disabled by the organization") — yet a **dispatched** run publishes
> fine, so the trigger event, not the org setting, is what differs. If a release job
> ever fails this way again, re-run it via `workflow run` rather than chasing the
> permission.

Once the run is dispatched, ~10–15 min later a **GitHub Release** appears with:
`.dmg` (arm64 + x64), `.msi` + `.exe` (Windows), `.AppImage` + `.deb` (Linux) —
plus **stable-named copies** of the installers, which the download page links:

| Stable name (never changes) | Copy of |
|---|---|
| `Beecork-Terminal-macOS-AppleSilicon.dmg` | `…_aarch64.dmg` |
| `Beecork-Terminal-macOS-Intel.dmg` | `…_x64.dmg` |
| `Beecork-Terminal-Windows-x64-setup.exe` | `…_x64-setup.exe` |
| `Beecork-Terminal-Linux-x86_64.AppImage` | `…_amd64.AppImage` |
| `Beecork-Terminal-Linux-amd64.deb` | `…_amd64.deb` |

`https://github.com/beecork/beecork-terminal/releases/latest/download/<stable name>`
always resolves to the newest release, so the page works with no API call. The
GitHub API path is what failed with a group in one room: 60 unauthenticated
requests/hour **per IP**, shared by everyone behind the venue's Wi-Fi. Confirm
the copies are there with the `gh release view … --jq '.assets[].name'` above
before deploying a page that links them — and if you ever rename one, rename it
in `release.yml` and `site/terminal/index.html` in the same commit.

**Then prove Linux starts** — there is no Linux machine on the team, and Linux
fails silently (a window that never fills in, an AppImage that exits at once):
```bash
gh workflow run linux-smoke.yml -f tag=v0.1.29
gh run watch      # then download the run's `smoke-*` artifacts for the screenshots
```

**If a user reports a crash**, every install since v0.1.29 keeps a local log
(Settings → Diagnostics → "Show log file"): every launch, every Rust panic with
its backtrace, every uncaught webview error. Ask for that file first. What it
cannot contain is a crash *below* Rust (WebKit/WebView2 itself, Gatekeeper); for
those ask for Console.app → Crash Reports (macOS) or Reliability Monitor →
"View technical details" (Windows, `perfmon /rel`).

---

## Website: the download page

The page is drafted at `site/terminal/` in this repo. To publish it on
**beecork.com** (a static site auto-deployed to Cloudflare Pages on push to
`main`):

### 1. Copy the page into the site **[you]**
```bash
cp -r site/terminal /Users/apple/Coding/Beecork/beecork-pipe/beecork-site/terminal
```

### 2. Add the nav link + product card to the homepage **[you]**

In `beecork-site/index.html`:

- **Nav** — after `<a href="/pipe/">Pipe</a>` add:
  ```html
  <a href="/terminal/">Terminal</a>
  ```

- **Product card** — after the Beecork Pipe `<div class="product pipe"> … </div>`
  block, add a Terminal card (mirrors the existing cards; it's a *download*, not
  an npm install):
  ```html
  <!-- Beecork Terminal (desktop) -->
  <div class="product terminal">
    <div class="p-label">Desktop app</div>
    <div class="p-name">
      <h2>Beecork&nbsp;Terminal</h2>
      <span class="pkg">macOS · Windows · Linux</span>
    </div>
    <p class="p-tag">A desktop cockpit for CLI coding agents.</p>
    <ul class="p-feats">
      <li>Full terminal running Claude Code or any CLI agent</li>
      <li>Live git-aware diff view as the agent edits</li>
      <li>File browser + editor, sessions, splits, themes</li>
    </ul>
    <div class="p-actions">
      <a class="p-cta" href="/terminal/">Download Beecork Terminal →</a>
      <div class="p-links">
        <a href="https://github.com/beecork/beecork-terminal" target="_blank" rel="noopener noreferrer">GitHub</a>
      </div>
    </div>
  </div>
  ```
  Optionally add a color accent for `.product.terminal` in the homepage `<style>`
  (the app's accent is violet `#a78bfa`):
  ```css
  .product.terminal { --bar: linear-gradient(90deg, #a78bfa, #c4b5fd); --barborder: #a78bfa; }
  .product.terminal .p-label { color: #c4b5fd; }
  .product.terminal .p-feats li::before { background: #a78bfa; }
  .product.terminal .p-cta { background: #a78bfa; }
  ```

### 3. Deploy **[you]**
```bash
cd /Users/apple/Coding/Beecork/beecork-pipe/beecork-site
git add -A && git commit -m "Add Beecork Terminal download page" && git push
```
The site's own workflow deploys to Cloudflare Pages automatically.

---

## How it compares to CozyPane

| | CozyPane (Electron) | Beecork Terminal (Tauri) |
|---|---|---|
| Build tool | `electron-builder`, hand-rolled matrix | `tauri-apps/tauri-action` (build+sign+release in one) |
| Mac artifacts | `.zip` | `.dmg` (+ `.app.tar.gz` for updater) |
| Win artifacts | `.exe` (NSIS) | `.exe` (NSIS) + `.msi` |
| Linux artifacts | AppImage/deb/rpm | AppImage/deb |
| Auto-update | electron-updater (`latest*.yml`) | Tauri updater (`latest.json`) — wired |
| Release trigger | `v*` tag | `v*` tag (same) |
| Download site | static + GitHub API | static + GitHub API (same technique) |
| Site deploy | Cloudflare Pages | Cloudflare Pages (same) |

## Known gaps (deliberate, for later)

- **Windows code signing** isn't set up → Windows SmartScreen shows an
  "unknown publisher" warning until an EV/OV cert is added. (CozyPane has the
  same gap.)
- **Linux** builds on `ubuntu-22.04` (WebKitGTK 4.1), so the AppImage needs
  glibc ≥ 2.35 (Ubuntu 22.04 / Debian 12 / Fedora 36 or newer); older distros
  fail to start it with a `GLIBC_2.35 not found` message. `linux-smoke.yml`
  covers Ubuntu 22.04 and 24.04; nothing covers Fedora/Arch or Wayland+NVIDIA.
- **No crash telemetry.** The crash log is local-only by design (the app watches
  people's source trees); an opt-in reporter (`tauri-plugin-sentry`, which also
  captures native minidumps the log can't see) is the next step if local logs
  prove too slow to collect.
