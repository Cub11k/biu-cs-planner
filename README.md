# BIU CS Planner

A local course planner for Bar-Ilan University Computer Science students: lay a degree out across
Semesters, and build the weekly Timetable for an Academic Year.

> **Status: early.** The design is agreed and the scaffold builds, but there is no working app yet.
> Nothing is published to npm. See [the open issues](https://github.com/Cub11k/biu-cs-planner/issues)
> for what is being built.

## What it is for

- **The Timetable** is the main reason the app exists: pick a Group per Lesson Type, see Clashes
  and Exam spacing, and keep several named Variants of a week side by side. It needs only a
  Catalog, with no Plan and no Requirements File.
- **The Plan** lays Attempts out across Semesters, and **Progress** evaluates them against a
  Program's Requirements.
- It runs **locally and offline**. Personal data lives in real files in a folder you own; the
  browser is only the screen. The planner is used mostly around registration windows.
- **Hebrew and English**, right-to-left supported from the first component.

The vocabulary above is precise, and [`CONTEXT.md`](CONTEXT.md) defines every term in it.

## Development

Node **22 or newer** (developed on Node 24; `@types/node` tracks the 22 floor on purpose).

```sh
npm install
npm test          # Vitest, core + app + server
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
