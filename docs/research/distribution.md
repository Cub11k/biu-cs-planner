# Distribution options research

Researched 2026-09-11 by a web research agent, from primary sources (Bun docs, releases and issues; caniuse; MDN compat data; Apple, Microsoft and Chrome docs; Mozilla and WebKit standards positions). Items marked **[unverified]** had only secondary sources. The decision this informed is [ADR 0001](../adr/0001-npm-package-served-on-localhost.md). The shortcut and background-server findings are kept here for when those features are picked up.

## A) Bun `--compile` executables (rejected)

- **Targets and size:** one machine can cross-compile darwin-x64/arm64, linux-x64/arm64 (glibc and musl) and windows-x64/arm64 ([docs](https://bun.com/docs/bundler/executables)). Windows icon and metadata flags don't work when cross-compiling. Bun 1.4 binaries are about 77 MB (Linux x64) and 85 MB (Windows x64) ([1.4 notes](https://bun.com/blog/bun-v1.4)). Bun 1.4 (Aug 2026) was reported as a large rewrite with early regressions (fixed in 1.4.1 and 1.4.2).
- **macOS signing:** arm64 requires a signature; Bun ad-hoc signs automatically. It broke in 1.3.12, producing truncated signatures ([#29120](https://github.com/oven-sh/bun/issues/29120)). The macOS 27 beta killed binaries with slightly wrong signatures up to 1.4.0 ([#32159](https://github.com/oven-sh/bun/issues/32159), fixed in [1.4.1](https://bun.com/blog/bun-v1.4.1)). Pin Bun ≥1.4.1 and run `codesign --verify --strict` in CI if this path is ever revisited.
- **Gatekeeper:** it checks only quarantined files. Browsers set the quarantine flag; `curl` does not ([Apple DTS](https://developer.apple.com/forums/thread/666452)). Since Sequoia, Control-click → Open no longer bypasses it ([Apple](https://developer.apple.com/news/?id=saqachfa)). Users must go to System Settings → Privacy & Security → "Open Anyway" and enter a password, within about an hour of the first attempt ([guide](https://support.apple.com/guide/mac-help/open-a-mac-app-from-an-unknown-developer-mh40616/mac)).
- **Double-click in Finder:** opens Terminal with the working directory set to the home folder, not the binary's folder **[unverified]**. Locate the app folder via `process.execPath`, never the working directory. Browser downloads of raw binaries may lose the executable bit, so ship a zip **[unverified]**.
- **Intel Macs:** Rosetta is due to be phased out in macOS 28 ([Eclectic Light](https://eclecticlight.co/2026/01/17/whats-happening-with-code-signing-and-future-macos/)).
- **Windows:**
  - SmartScreen warns about downloaded unsigned or low-reputation files ([MS Learn](https://learn.microsoft.com/en-us/windows/security/operating-system-security/virus-and-threat-protection/microsoft-defender-smartscreen/)). `Invoke-WebRequest` downloads get no Mark-of-the-Web, so SmartScreen skips them (secondary sources).
  - **Smart App Control** blocks unsigned apps with no per-app override, and can now be turned on without reinstalling Windows ([MS](https://support.microsoft.com/en-us/topic/what-is-smart-app-control-285ea03d-fa88-4d56-882e-6698afdb7003)).
  - Defender and Norton have flagged `bun.exe` itself ([#16981](https://github.com/oven-sh/bun/issues/16981), [#19155](https://github.com/oven-sh/bun/issues/19155)).
  - `--windows-hide-console` was a no-op until [PR #36292](https://github.com/oven-sh/bun/pull/36292). Hiding the console also hides errors and Ctrl+C, so a UI Quit button becomes necessary.

## B) GitHub Pages PWA with the File System Access API (rejected)

- **Support:** `showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker` and writable streams on real files work only in Chrome, Edge and Opera desktop ([caniuse](https://caniuse.com/native-filesystem-api)). Mozilla's position is negative ([#154](https://github.com/mozilla/standards-positions/issues/154)); WebKit's is oppose ([#28](https://github.com/WebKit/standards-positions/issues/28)). Firefox and Safari support writable streams only in the origin-private file system (OPFS), which users can't see.
- **Remembered access:** Chrome 122+ offers "Allow on every visit" for stored handles, and installed PWAs keep access automatically ([Chrome](https://developer.chrome.com/blog/persistent-permissions-for-the-file-system-access-api)).
- **`FileSystemObserver`:** Chrome 133+ desktop only, experimental.
- **Fallback in other browsers:** `<input type=file>` import, download export, IndexedDB working copy.
- **Service worker on Pages:** scope must match the repo subpath (`/repo/`). GitHub Pages sends `max-age=600`, and custom headers are impossible. All project sites share the `user.github.io` origin (storage and permissions) unless a custom domain is used.
- **Installing as an app:** Safari 17+ macOS has "Add to Dock", still without file access. Firefox web apps (143+) are Windows-only.
- **CORS:** `raw.githubusercontent.com` and `*.github.io` both send `Access-Control-Allow-Origin: *` (checked with curl).

## C) Other options considered

- **Go executable + TypeScript UI:** about 10 MB binaries, trivial cross-compilation without C dependencies, stdlib HTTP, UI embedded in the binary. But two toolchains and schemas duplicated between Go and TS, and the same signing and antivirus exposure as (A).
- **Python package (`uvx` / `pipx`):** installing uv also fetches Python itself, so it's the smoothest start from nothing. But two languages (Python domain, TS UI, OpenAPI codegen between them).
- **Official Bun runtime + app bundle + launcher scripts** (`start.command` / `start.cmd`): avoids shipping an unsigned executable of our own. Whether official Bun builds are signed was **not verified**.

## Notes for the deferred shortcut / background-server work

- **Launch:** a shortcut launch has no terminal, so the pairing code can't be shown. The agreed recovery is that launching again finds the running instance (lock file in the Workspace, probe a health endpoint) and opens the browser with the token URL. `biu-cs-planner url` covers other browsers.
- **Lifecycle options:**
  - (a) Detach a background server that stops via a UI Quit button or after N minutes without a UI heartbeat.
  - (b) Keep a terminal window open that holds the server.
- **Opening the browser:** Bun and Node have no built-in "open browser" API. The usual approach is spawning `open` (macOS), `cmd /c start "" <url>` (Windows) or `xdg-open` (Linux) **[unverified]**.
- **Server basics:** bind `127.0.0.1` explicitly (`Bun.serve` defaults to `0.0.0.0`). Use a fixed preferred port: every port is a separate browser origin, so a random port loses `localStorage` (and the token) between runs.

## Keeping development tools project-local (applies today)

- **Bun:**
  - `bun install` caches to `~/.bun/install/cache` by default; override with `BUN_INSTALL_CACHE_DIR` or `[install.cache] dir` in `bunfig.toml`.
  - Bun's `install.sh` honors `BUN_INSTALL` but still appends to writable `.zshrc`/`.bashrc`, with no opt-out.
  - `install.ps1` has `-NoPathUpdate`.
  - Cleanest is unzipping the release asset into the project.
- **Node, npm and Playwright:** the same idea applies. Download the Node release archive into the project, set the npm cache inside the project, and set `PLAYWRIGHT_BROWSERS_PATH` inside the project.
