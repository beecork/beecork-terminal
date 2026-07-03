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
| `site/terminal/index.html` | The `beecork.com/terminal/` download page — detects OS + fetches the latest GitHub release. **Copy to the beecork-site repo** (see below). |

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

### 3. Auto-update signing key — *optional follow-up*

Auto-update (the app updating itself from GitHub Releases) is not wired yet;
it's a small follow-up. When you want it:

```bash
npm run tauri signer generate -- -w ~/.beecork/beecork-terminal-updater.key
```
Then:
- `gh secret set TAURI_SIGNING_PRIVATE_KEY --repo beecork/beecork-terminal < ~/.beecork/beecork-terminal-updater.key`
- `gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo beecork/beecork-terminal` (the password you chose)
- Install the plugin: `npm i @tauri-apps/plugin-updater` + `cargo add tauri-plugin-updater` (in `src-tauri`), register it in `src-tauri/src/lib.rs`, and add to `tauri.conf.json`:
  ```json
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "endpoints": ["https://github.com/beecork/beecork-terminal/releases/latest/download/latest.json"],
      "pubkey": "<the public key printed by signer generate>"
    }
  }
  ```
  (Ping me and I'll do this code part.)

---

## Cutting a release

```bash
# bump version in package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml
git commit -am "v0.1.0"
git tag v0.1.0
git push --follow-tags
```

The tag triggers `release.yml`. ~10–15 min later a **GitHub Release** appears with:
`.dmg` (arm64 + x64), `.msi` + `.exe` (Windows), `.AppImage` + `.deb` (Linux).

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
| Auto-update | electron-updater (`latest*.yml`) | Tauri updater (`latest.json`) — *follow-up* |
| Release trigger | `v*` tag | `v*` tag (same) |
| Download site | static + GitHub API | static + GitHub API (same technique) |
| Site deploy | Cloudflare Pages | Cloudflare Pages (same) |

## Known gaps (deliberate, for later)

- **Windows code signing** isn't set up → Windows SmartScreen shows an
  "unknown publisher" warning until an EV/OV cert is added. (CozyPane has the
  same gap.)
- **Auto-update** is scaffolded in the workflow (env vars present) but the app
  plugin isn't wired yet — see step 3 above.
- **Linux** builds on `ubuntu-22.04` (WebKitGTK 4.1). This is the platform to
  smoke-test first, per the original stack decision.
