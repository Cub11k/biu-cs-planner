# Dispatching more than one implementation agent at once

**Every agent gets one ticket, one worktree, and one lane of files it may write. Everything
outside its lane is read-only to it.** One worktree per piece of work is already the rule
(`worktrees.md`); this file is what changes when several of them run at the same time.

None of what follows is derivable from the code. Each rule is a mistake that was made once,
written as the thing that prevents it.

## Lanes

The dispatch brief carries a table with one row per agent and the files that row may create or
edit, and the rows do not overlap. Two agents editing one file is a merge conflict that neither
of them can see coming, because neither can read the other's uncommitted work.

The table belongs in the brief, not in this file: it is rewritten for every run.

Three things hold regardless of what the table says:

- **Other worktrees are not yours.** `git worktree list` will show them. Never run a command
  with `-C` pointing at another worktree, and never run a repo-wide command from the main
  checkout, which stays on `dev`.
- **The ticket wins over the lane.** If the ticket asks for something the table did not
  anticipate, do it — the scoping has been the incomplete thing before. Say in the pull request
  that you went outside the lane and which file it was, so the merge can be sequenced.
- **Prefix every scratch file with your ticket number.** The scratchpad is shared across agents
  and sessions. A run in September 2026 had two scratch files overwritten mid-task by a sibling
  agent, and one measurement briefly reported another worktree's numbers as its own. Never trust
  a scratch file you did not write in this run.

## Reviewers are read-only, and have to be told so in those words

After the repo's own checks pass, spawn two independent reviewers: one against the ticket's
acceptance criteria, one against the guardrails in `CLAUDE.md`.

Tell each one, in those words, that it is **read-only**. On 2026-09-16 a review subagent ran
`git stash` in its parent's worktree in the middle of a commit, and the commit that resulted
recorded a file its own message described wrongly. `git stash`, `git reset`, `git checkout --`
and `git add` are writes. A subagent that thinks of itself as a reviewer will still reach for
them unless it is told not to.

**Tell them the scratch-file rule too**, for the same reason: a reviewer writes notes and
throwaway scripts like anyone else, and it has no way to know the scratchpad is shared. In one
run an agent kept the rule perfectly and its two reviewers wrote unprefixed files beside it,
because relaying the rule had not occurred to anyone.

## Ask whether the test passes for the reason you think it does

```sh
npm run typecheck && npm test
```

Add `npm run report` when your change touches what the report shows — it runs coverage and
builds the module and call graphs, the test titles and the untested-function list.

**`npm run review` is not yours to run.** It is the CI entrypoint: `tools/pr-review/main.ts`
requires `GITHUB_REPOSITORY`, `GITHUB_TOKEN`, `PR_NUMBER` and `REVIEW_MODE`, and it posts a
comment on the pull request. Locally it exits on the first missing variable, and with the
variables it would post the comment this project has already decided it does not want. Two
agents each spent budget rediscovering that in one run, which is why it is written here.

When the graph checks are what you need, call them rather than the script: `moduleCycles`,
`callCycles` and `forbiddenEdges` over `collect()`. That is the part of the review that
judges your change, without the part that talks to GitHub.

Green is not the claim. The claim is that the test would fail if the behaviour regressed, and the
way to know is to delete the implementation and watch it fail.

A `:focus-visible` assertion once passed because Chromium draws its own focus ring, so removing
the rule under test changed nothing the test could see. It had never tested anything.

**Commit before you mutate.** `git checkout -- <file>` reverts to the last commit, not to where
you were, so using it to undo a deliberate mutation discards any uncommitted work in that file —
including the review fixes you are in the middle of. Three agents did this to themselves across
two runs in September 2026, and one then measured three mutations against a file it had silently
reverted. Commit, then mutate, then revert.

## Verification discipline

- **Verify a creation by number, not by a listing.** After creating an issue, comment or pull
  request, fetch it directly. `gh issue list` served stale reads during a GitHub incident and a
  duplicate got filed. See `issue-tracker.md`.
- **Never claim a CI or pull request state you have not just fetched.** Runs take a couple of
  minutes to appear, and "no runs at all" was wrong twice because it was read too early.
- **`npm install` in a worktree warns that some packages have install scripts not covered.**
  That warning is expected — esbuild — and `--ignore-scripts` is deliberate
  (`CLAUDE.md`, "Code guardrails"). Do not "fix" it and do not approve the scripts.
- **Measure the test baseline on clean `dev` at dispatch time** and put the number in the brief.
  Hardcoding it here guarantees it is wrong by the next merge. If a run sees fewer test files
  than that baseline plus its own, the run is wrong, not the repo.
- **Re-check your invocation before reporting a tool broken.** An esbuild check was once called
  broken because a string had been passed where an options object belonged.

## Reporting, and running out of budget

Say what you did, why, what you measured, what you deliberately did not do, and anything you
found that belongs in a separate ticket. If an acceptance criterion is unmet, say so; if you
could not measure something, say that rather than implying you did. A wrong claim in a pull
request body costs more to undo than an open question costs to answer.

Budget is finite and it does not protect your progress — pushing does. Commit in coherent steps
as you go. If you are going to run out, **push what you have, open a draft pull request, and say
exactly where you stopped.** An agent once died mid-ticket and left a pushed commit with no pull
request and no note, which cost more to reconstruct than the ticket had cost to write.

## Merging is the orchestrator's part, and it can break a live agent

Most of what is above is addressed to the agent. This section is not: it is for whoever dispatches
the run and merges what comes back.

- **Do not merge an agent's pull request until that agent has reported.** A green pull request is
  not a finished agent: its reviewers may still be running, and a review can change the diff.
  Merging early breaks the agent in two ways it cannot anticipate — a `git push` to the branch the
  merge deleted **silently recreates it**, leaving a branch behind with no pull request attached,
  and post-merge cleanup removes the worktree the agent is standing in, so its next command fails
  in a directory that is gone. On 2026-09-24 #101 was merged mid-review; its agent found out when
  a `cd` failed, and spent a large part of its budget reconstructing what had landed, re-opening
  the rest as a second pull request, and deleting the branch its own push had resurrected. Waiting
  costs a few minutes. **Do not remove a worktree under a live agent** either, for the same reason;
  and if a pull request has to be merged early or a worktree taken away regardless, **tell the
  agent first**, because it cannot see either happen.
- **Verify between merges, not after the batch.** Pull requests are verified against the base they
  branched from, never against each other, so a batch that is green one by one can be red merged.
  `MERGEABLE` means there was no textual conflict and nothing more. Run
  `npm run typecheck && npm test` on `dev` after **each** merge, and expect a check added by one
  pull request to be what another's new tests trip — a new guardrail's whole job is to notice code
  it has never seen. On 2026-09-25 five green pull requests produced a red `dev`, because one of
  them added the rule that another's tests broke.
- **Predict both counts before merging, and check them after** — test files and tests, summed from
  each branch's own measurement. That batch reached its predicted total exactly, which is what made
  it obvious the three failures were a collision rather than a lost test file. It is the cheapest
  signal there is that a merge lost or gained something nobody meant.
- **`gh pr merge --delete-branch` can leave the remote branch behind.** It tries the local branch
  first, fails while a worktree still holds it, and aborts before deleting the remote, so the flag
  reports nothing unusual — #116's was still there afterwards. Clean up in the order that works:
  remove the worktree, then delete the branch, and verify with `git ls-remote`.

## What stays in the dispatch brief

Anything that is true of one run and not the next: the lanes table, the test baseline for that
run, the date and the number of agents, and the `Co-Authored-By` and `Claude-Session` lines for
the session doing the dispatching.

**What must not stay there is anything that will be true of the next run too.** A brief is
rewritten every run and read once, under load: the `git checkout -- <file>` hazard above was
warned about in prose in the brief for the run after it was first hit, and an agent hit it anyway.
A briefing is not a substitute for this file. If a run learns something the next run needs, it
belongs here, and the pull request that learned it is the cheapest place to propose the line.

## Rules that live elsewhere, and are not repeated here

- The code guardrails, the `--ignore-scripts` rule and the branching model — `CLAUDE.md`
- Frozen ticket bodies, and amendments as comments — `issue-tracker.md`
- Why a worktree at all, and how to create and remove one — `worktrees.md`
- The vocabulary code and commits must use — `CONTEXT.md`
- Crawled data staying out of this repo — ADR-0006, and `CLAUDE.md`
