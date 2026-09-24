# BIU CS Planner

A local course planner for Bar-Ilan University Computer Science students: lay a degree out across
Semesters, and build the weekly Timetable for an Academic Year.

> **Status: early, and honest about it.** `0.1.0` is the first real release, and the Timetable
> is what works: import a Catalog, pick a Group per Lesson Type, see Clashes, and find your
> picks still there after a restart. The Plan, Progress and Requirements are designed and not
> built. See [the open issues](https://github.com/Cub11k/biu-cs-planner/issues) for what is next.

## What it is for

- **The Timetable** is the main reason the app exists: pick a Group per Lesson Type and see
  Clashes as you build the week. It needs only a Catalog, with no Plan and no Requirements
  File. **This is the part that works today**, with one Variant per Semester — Exam spacing
  and several named Variants side by side are designed and not built yet.
- **The Plan** lays Attempts out across Semesters, and **Progress** evaluates them against a
  Program's Requirements. **Neither is built yet.**
- It runs **locally and offline**. Personal data lives in real files in a folder you own; the
  browser is only the screen. The planner is used mostly around registration windows.
- **Hebrew and English**, right-to-left supported from the first component.

The vocabulary above is precise, and [`CONTEXT.md`](CONTEXT.md) defines every term in it.

## Running it

One command starts it:

```sh
npx biu-cs-planner            # in the folder you keep your planning files in
```

It serves `http://localhost:8900`, prints that URL with your launch token in the fragment,
and opens a browser.

| Option | Does |
| --- | --- |
| `--workspace <path>` | the Workspace folder to use (default: the current directory) |
| `--no-open` | print the URL but open no browser |
| `--host <address>` | the address to bind; loopback only, because serving further out needs a password and there is none yet ([ADR-0004](docs/adr/0004-localhost-auth-bearer-token.md)) |
| `--help` | the same list |

If port 8900 is taken it uses the next free one and says so. Stop it with Ctrl-C.

## Your files, and removing it

Everything it keeps is in the folder you started it in, in plain JSON:

| Path | Holds |
| --- | --- |
| `catalogs/<year>.json` | a Catalog you imported, one file per Academic Year |
| `requirements/` | Requirements Files, once there are any to put there |
| `me.state.json` | your picks. One State File, and `me` is the only name it uses so far |
| `.backups/` | reserved for backups; nothing writes here yet ([#67](https://github.com/Cub11k/biu-cs-planner/issues/67)) |

Those files are the whole of your data, and they are yours: removing the app never touches
them, and deleting them never breaks the app.

To remove the app itself, there is nothing to uninstall if you ran it with `npx` — it leaves
only npm's download cache, which `npm cache clean --force` clears. If you installed it with
`npm install -g biu-cs-planner`, then `npm uninstall -g biu-cs-planner`.

## Development

Node **22 or newer** (developed on Node 24; `@types/node` tracks the 22 floor on purpose).

```sh
npm install
npm run install:browsers  # Chromium for the browser tests; `playwright` downloads no browser on install, so this is how you get one
npm test            # Vitest: core + app + server + web, and the Timetable's layout in Chromium
npm run test:node   # the same without the browser project, if you skipped the line above
npm run typecheck
npm run dev:server  # API on http://127.0.0.1:8900
npm run dev:web     # Vite dev server, proxying /api to the above
npm run build
```

Four npm workspaces, and the boundary between them is the point:

| Workspace | Holds |
| --- | --- |
| `core` | pure domain: Requirement engine, Assignment solver, Clashes, Exams. No I/O. |
| `app` | use cases, plus the Workspace port for reading and writing files |
| `server` | Hono HTTP API over `app`, filesystem Workspace adapter, CLI entry point |
| `web` | thin React UI, reaching the API only through its typed client |

`web` never imports `core` or `app`; it knows the API contract and nothing else. The API exposes
domain operations, never file paths.

`npm run build` bundles the server into `dist/cli.js` with esbuild, builds the UI with Vite
and copies it next to the bundle as `dist/ui/`. Those two are the whole published package:
it declares no runtime dependencies, so an install pulls one package and nothing else.

A release is a tag on `master`, which is what triggers CI to test, build, check the packed
tarball and publish it to npm with provenance. Nothing is published from a laptop.

## No course data here

This repo ships no BIU data and never will. Crawling the Shoham catalog lives in a separate
crawler repo, and published Catalogs and Requirements Files live in a separate data repo — see
[ADR-0005](docs/adr/0005-crawler-separate-repo-near-raw-output.md) and
[ADR-0006](docs/adr/0006-data-repo-separate-from-code.md). You import your own files, or crawl
your own.

## Documentation

- [`CONTEXT.md`](CONTEXT.md) — the domain glossary; the words the code uses
- [`docs/design.md`](docs/design.md) — the agreed design, build order, deferred items, open facts
- [`docs/adr/`](docs/adr/) — why the hard-to-reverse decisions went the way they did
- [`docs/research/`](docs/research/) — findings on BIU's data sources and on distribution
- [`prototypes/`](prototypes/) — throwaway code that settled the Timetable screen

## License

[MIT](LICENSE).
