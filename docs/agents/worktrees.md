# One worktree per piece of work

**Any skill that implements something — `/implement`, `/tdd`, a fix, a refactor — runs in a
worktree created for it and removed when the work lands.** Not in the main checkout, and
never in a worktree another piece of work is already using.

## Why

On 2026-09-13 two sessions ran in the same checkout, one on #2 and one on #6. The second
created its branch and switched the shared checkout onto it, so the first session's
uncommitted work sat on the other's branch. Both sessions then edited
`core/src/shoham/import.ts` in turn, and a test failure in one was caused by the other's
half-finished change.

Nothing was lost, because neither had committed and every branch still pointed at the same
commit. That was luck.

Worktrees remove the shared mutable thing. Two sessions cannot switch each other's branch,
overwrite each other's files, or read a file mid-edit by someone else.

## How

```sh
# from the main checkout, which stays on dev
git worktree add ../biu-cs-planner-<issue> -b <issue>-<slug> dev
cd ../biu-cs-planner-<issue>
npm install            # a worktree has its own node_modules
```

Work, commit, push, open the pull request. Once it merges:

```sh
git worktree remove ../biu-cs-planner-<issue>
git branch -d <issue>-<slug>
```

- Name the directory after the issue, so `git worktree list` reads as a list of what is in
  flight.
- Branch from `dev` and open the pull request into `dev` — the branching model in
  `CLAUDE.md` is unchanged, this is only about where the files live.
- The main checkout stays on `dev` and holds no feature work.

## Before starting, and this is the part that matters

```sh
git worktree list      # what else is in flight, and on which branch
git status             # changes here that are not yours mean stop
```

A working tree holding edits you did not make is another session's. Do not revert them, do
not commit them, and do not build on top of them. Say so and agree who owns what: the cost
of asking is a message, and the cost of not asking is the afternoon described above.
