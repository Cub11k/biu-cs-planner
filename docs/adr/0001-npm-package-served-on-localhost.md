# Distribute as a TypeScript npm package served on localhost

The app must install with a one-line command for CS students, keep data in real files, work in any browser, and never require code signing, antivirus exceptions or Gatekeeper workarounds. We ship one npm package (`npx biu-cs-planner` or `npm i -g`) with zero runtime dependencies, which serves the UI on `127.0.0.1`. TypeScript everywhere means the domain core, the API contract and the UI share one set of schemas.

## Considered Options

- **Go executable + TypeScript UI:** small binaries, but two toolchains and schemas defined twice. Rejected once executables were rejected, because the size advantage stopped mattering.
- **Bun `--compile` executables:** about 80 MB each, macOS ad-hoc signing bugs in 2026, Gatekeeper "Open Anyway" for browser downloads, and Windows Smart App Control blocking unsigned executables with no per-app override.
- **GitHub Pages PWA using the File System Access API:** no install, but live files work only in Chromium browsers (Mozilla and WebKit oppose the API).
- **Python package via `uvx`:** the smoothest install when nothing is present (uv fetches Python itself), but two languages.

Details are in [`../research/distribution.md`](../research/distribution.md).

## Consequences

- Users need Node ≥22, or Bun or Deno. Students with neither can install Bun with a one-liner.
- Desktop shortcuts and a terminal-less background server are deferred, since a shortcut has no terminal to show the pairing code.
