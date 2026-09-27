# IronClad Pro

Knee-safe, full-body strength, fat-loss and rehab tracker. Runs as an installable iPhone app (PWA) from GitHub Pages and works offline.

## Install on iPhone
Open the site in **Safari** → **Share** → **Add to Home Screen**. It then launches full-screen with its own icon and works with no signal.

## Editing the app
- Edit **`src/index.html`** — the app source (React + JSX in a single file).
- `index.html` and `sw.js` are **generated**: run `npm run build` after every change and commit the output.
- Bump `version` in `package.json` for each release. The build stamps it everywhere and gives the service worker a fresh cache, so phones pick up the update the next time they open the app online.

```sh
npm install            # React (vendored into vendor/) + Babel (used by the build)
npm run build          # src/index.html -> index.html + sw.js
npm test               # build + end-to-end tests (needs Playwright; set CHROME_PATH if needed)
npm run assets         # re-render icons/ and splash/ from icons/icon.svg
```

## Layout
| Path | What |
|---|---|
| `src/index.html` | App source |
| `build.js` | Pre-compiles the JSX, stamps the version, writes `index.html` + `sw.js` |
| `vendor/` | React 18 production builds (served locally so the app works offline) |
| `manifest.webmanifest`, `icons/`, `splash/` | Home-screen install metadata, icon and launch screens |
| `tests/e2e.js` | End-to-end tests (install assets, offline, full-body coverage, sessions, backups) |
| `tools/` | Asset renderer and the iPhone screen-size list |
