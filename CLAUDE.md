# BIU CS Planner

A local course planner for Bar-Ilan CS students: degree Plan across Semesters plus a Timetable per Academic Year. Status: design agreed, no code yet.

## Read first

- `CONTEXT.md`: the domain glossary. Use its terms in code, docs and conversation, and update it when a term changes.
- `docs/design.md`: the agreed design, the next step, build order, deferred items and open facts.
- `docs/adr/`: why hard-to-reverse decisions were made. Read the relevant ADR before proposing an alternative.
- `docs/research/`: findings on BIU data sources, distribution options and shortcuts. Check here before researching those again.

## Project conventions

Development happens on temporary machines. The project lives on GitHub at `Cub11k/biu-cs-planner` (public, default branch `dev`), so a new machine gets it with a clone.

- Node and npm come from the machine. The only project-local things are `package.json`, the npm workspaces and `node_modules/`; a clean slate is `rm -rf node_modules && npm install && npm run install:browsers`.
  The browser download is its own command because every install here passes `--ignore-scripts` and Playwright downloads its Chromium from a postinstall. Without it `npm test` cannot start the browser project; `npm run test:node` is the rest of the suite and needs nothing.
- **Branching follows git flow.** `dev` is the default branch and where work lands; `master` holds releases only. A feature branches off `dev`, is named `<issue number>-<slug>`, and opens a pull request back into `dev`. A release is `dev` merged into `master`, and a tag on `master` is what triggers CI to test, build and publish.
- Every pull request that touches code gets a generated report posted to it: the module and call graphs, every test title, coverage, and the functions no test entered. Read that before reading a diff — it is derived from the source, so it cannot drift from it. `npm run report` builds the same thing locally.
- Project knowledge lives in this folder (this file, `docs/`) rather than in `~/.claude` memory.
- `.sessions/` holds copies of Claude Code session transcripts. They contain personal data (email, home paths), so `.gitignore` keeps them untracked and they stay out of anything published. To resume a session on another machine, copy `<id>.jsonl` and the `<id>/` folder into `~/.claude/projects/<project path with every / replaced by ->/`, then run `claude --resume <id>`.
- Crawled data lives outside this repo, in the sibling folder `../biu-cs-planner-crawl/data/` (`raw/` and `build/`). [ADR-0005](docs/adr/0005-crawler-separate-repo-near-raw-output.md) keeps the crawler next to its Raw Crawl output and [ADR-0006](docs/adr/0006-data-repo-separate-from-code.md) keeps published Catalogs and Requirements Files out of the code repo, which is public.

## Code guardrails

- `core` is pure and developed test-first. `web` talks only to the HTTP API through the typed client, never importing `core` or `app`.
- The API exposes domain operations, never file paths.
- Data from files is interpreted, never executed: no `eval`, `new Function`, or regular expressions built from data.
- Every domain check produces a Warning; edits always go through.
- UI strings go through translation files, and styling uses direction-neutral classes only (`ms-`/`me-`/`start-`/`end-`), so Hebrew right-to-left layout works from day one.
- Colors come from tokens that a dark scheme redefines; component styles hold no raw color values.
- **Every install in `.github/workflows/` passes `--ignore-scripts`**, and every workflow declares its own `permissions:` block, no wider than what it does. A dependency's install script is arbitrary code on a runner, and a runner can hold a token that writes to this repository. `tools/ci/workflows.test.ts` fails the build on an install without the flag, on a workflow that declares no `permissions:`, and on a write scope outside the short list it keeps — whether a token is *no wider than needed* stays a judgement made in review.

## Agent skills

### Issue tracker

GitHub Issues on `Cub11k/biu-cs-planner`, driven through the `gh` CLI. **A ticket's body is
frozen once written** — amendments go in the comment thread, as the exact edit they would be, so
the ticket stays the independent record of what was asked for. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Worktrees

Any skill that implements something runs in a worktree made for it and removed when the work
lands — never in the main checkout, which stays on `dev`. Check `git worktree list` and
`git status` before starting: changes you did not make belong to another session. See
`docs/agents/worktrees.md`.
