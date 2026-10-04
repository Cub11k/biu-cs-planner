# Dispatching more than one implementation agent at once

**Every agent gets one ticket, one worktree, and one lane of files it may write. Everything
outside its lane is read-only to it.** One worktree per piece of work is already the rule
(`worktrees.md`); this file is what changes when several of them run at the same time.

The ticket is a composed parent: two or three atomic asks that share a file lane, with the atomic
tickets as its sub-issues (`issue-tracker.md`, "How big a ticket is"). Its lane is therefore
already drawn by the grouping, and the table below records that lane rather than inventing one.

None of what follows is derivable from the code. Each rule is a mistake that was made once,
written as the thing that prevents it.

## Lanes

The dispatch brief carries a table with one row per agent and the files that row may create or
edit, and the rows do not overlap. Two agents editing one file is a merge conflict that neither
of them can see coming, because neither can read the other's uncommitted work.

The table belongs in the brief, not in this file: it is rewritten for every run.

These hold regardless of what the table says:

- **Other worktrees are not yours.** `git worktree list` will show them. Never run a command
  with `-C` pointing at another worktree, and never run a repo-wide command from the main
  checkout, which stays on `dev`.
- **The ticket wins over the lane.** If the ticket asks for something the table did not
  anticipate, do it — the scoping has been the incomplete thing before. Say in the pull request
  that you went outside the lane and which file it was, so the merge can be sequenced.
- **Two parents whose lanes intersect go in different runs.** Tickets are grouped by lane, but in
  a repo this size some parents still name a file in common — `issue-tracker.md` says so, and says
  not to answer it by splitting a parent back into atoms. Sequence them across runs instead. Do not
  put both in one table and hope the overlapping file is one neither of them reaches.
- **The table names `CONTEXT.md` and every `docs/adr/` file the run expects to be touched**, each
  one assigned to **at most one** agent. There is one `CONTEXT.md` and one `docs/adr/` for the whole
  repo (`domain.md`, "Layout: single-context"), so two agents amending one entry are two agents in
  one file, which the top of this section already rules out — and two agents each adding "the next
  free number" collide over the directory rather than over any line in it. A table does not arrive
  at those files on its own: an implementer reaches for the record *because* its own commit just
  made the record false, which for `CONTEXT.md` is what `CLAUDE.md` asks for in as many words
  ("update it when a term changes") and for an ADR is the same reflex one document over. So the
  files most likely to be written outside a lane are the ones a lane table never thinks to list.
  **When no agent can be given one, the brief says so**, and the amendment is left to the
  orchestrator after the merge — as its own ticket, worktree and pull request, because the main
  checkout stays on `dev` and holds no feature work (`worktrees.md`). On 2026-10-04 three of the
  four agents edited `docs/adr/` with no row naming it, each edit correct and each one declared:
  PR #194 and PR #195 both amended `0014-where-a-preference-is-kept.md` — at its line 32 and its
  line 11, missing each other by luck of line numbers — and PR #197 amended
  `0004-localhost-auth-bearer-token.md`. #110 records the same thing in the run of 2026-09-24: #103
  landed "in a run with four other agents, two of them writing in `docs/adr/`", with `CONTEXT.md`
  "outside every lane. Deliberately left rather than raced." Twice is a pattern.
- **Prefix every scratch file with your ticket number *and* something that identifies you within
  the ticket, which no other writer in it is using** — `182-review-1-graphs.ts`, not
  `182-graphs.ts`. The scratchpad is shared across agents and sessions. A run in September 2026 had
  two scratch files overwritten mid-task by a sibling agent, and one measurement briefly reported
  another worktree's numbers as its own — written down on #97, which does not name the run. The
  ticket number separates tickets, and a parent and its two reviewers are one ticket: all three
  derive the same prefix and then reach for the same obvious stem — `graphs`, `counts`,
  `baseline`.
  On 2026-10-04 #182's agent followed the rule exactly and told both its reviewers to, and one of
  them overwrote the parent's `182-graphs.ts`; the parent noticed because the output was not in the
  format it had written, re-ran its graph checks from a uniquely named file, and reported the
  collision itself (#199). Never trust a scratch file you did not write in this run.

## Reviewers are read-only, and have to be told so in those words

After the repo's own checks pass, spawn two independent reviewers: one against the ticket's
acceptance criteria, one against the guardrails in `CLAUDE.md`.

Tell each one, in those words, that it is **read-only**. On 2026-09-16 a review subagent ran
`git stash` in its parent's worktree in the middle of a commit, and the commit that resulted
recorded a file its own message described wrongly. `git stash`, `git reset`, `git checkout --`
and `git add` are writes. A subagent that thinks of itself as a reviewer will still reach for
them unless it is told not to.

**Tell them the scratch-file rule too**, for the same reason: a reviewer writes notes and
throwaway scripts like anyone else, and it has no way to know the scratchpad is shared. On
2026-09-24 an agent kept the rule perfectly and its two reviewers wrote unprefixed files beside
it — `count.ts`, `report-92.md` and `head-edges.txt` among them — because relaying the rule had
not occurred to anyone (#102). Hand each reviewer the identifier it is to use — `182-review-1-`,
`182-review-2-` — rather than leaving each to invent one, since a reviewer choosing for itself
cannot see what the other chose, and two that both pick `review` have each identified themselves
and still collided.

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
agents each spent budget rediscovering that in one run on 2026-09-24, each arriving independently
at the workaround below, which is why it is written here (#102).

When the graph checks are what you need, call them rather than the script: `moduleCycles`,
`callCycles` and `forbiddenEdges` over `collect()`. That is the part of the review that
judges your change, without the part that talks to GitHub.

Green is not the claim. The claim is that the test would fail if the behaviour regressed, and the
way to know is to delete the implementation and watch it fail.

A `:focus-visible` assertion once passed because Chromium draws its own focus ring, so removing
the rule under test changed nothing the test could see. It had never tested anything. #97 records
it, and PR #137 restates it in the same terms as something this repo "has been burned by", but
**which assertion and which run has not been established.** `git log -S':focus-visible' -- web/src`
returns six commits, PR #137's own among them, and the pass that went looking (on PR #221's thread)
proposed none of them rather than guess.

**Commit before you mutate.** `git checkout -- <file>` reverts to the last commit, not to where
you were, so using it to undo a deliberate mutation discards any uncommitted work in that file —
including the review fixes you are in the middle of. Three agents hit this across two runs in
September 2026 (#136, #137, #153), and one of them then took two mutation results off a file it
had silently reverted before catching it and re-running from a committed tree. All three caught it
themselves and reported it unprompted — #136 and #153 on their own threads, while **PR #137 records
nothing of it**: the account of that third one, the two mutation results included, is #175's body,
written from run reports this repository does not hold, and #175 names the three by their tickets
(#123, #114, #144) rather than by the pull requests cited here. Commit, then mutate, then revert.

**The restore has to name `HEAD:` — `git show :<path>` reads the index.** One character apart, and
the index form is the one that can hand back something you did not ask for: `git stash` followed by
`git stash pop` restores the working tree and leaves the **index at `HEAD`**, so a later
`git show :<path> > <path>` writes the committed file over your work while reading exactly like
`git show HEAD:<path>`, the revert the next paragraph names. On 2026-10-04 #209's agent lost an
uncommitted `web/src/history.ts` that way and re-applied it from its own patch script. It was
following the rule as written: the file named two spellings and the one sitting between them
behaves like neither. The occurrence is recorded on #226; PR #222, which that run landed as, does
not mention it. The conclusion is the one the paragraph above already draws, reached by a different
command — restore only from something you committed, and check that the thing you restore from is
the thing you think it is.

**Revert with `git show HEAD:<path> > <path>`.** It writes the committed content back over the file,
which is all the step needs, and it is the form that runs when `git checkout -- <file>` does not.
The redirect overwrites the working file exactly as `checkout` does, so it is no safer with
uncommitted work in that file and the commit-first step above still applies in full; what it is, is
one file written out of the object store rather than a command that reaches for the index and the
tree. It is not `checkout` spelled to slip past a denial. On 2026-10-04 #179's agent had that
`checkout` denied by the permission classifier as "Irreversible Local Destruction" and built its two
commits through the index instead, reverting each mutation from `HEAD`; PR #196 records the shape
("commit first, then mutate, then restore from `HEAD`") and the denial itself is on #200. Three
other agents in the same run ran `git checkout --` and were not blocked, so the denial is not
uniform, and an agent meeting it needs a step it can take rather than a judgement to make.

**A denied command is not permission to skip the mutation**, and not a thing to route around.
Report that it was denied and what you did instead. Do not hunt for a spelling that gets past it,
and do not edit a permission setting to let it through: those settings are not this document's to
change, and an agent that widens its own is no longer bound by them. Of the two, routing around the
denial is the worse: a skipped mutation is a gap in the evidence and the report can say so, while a
decision the settings made and an agent undid shows up nowhere.

## Verification discipline

- **Verify a creation by number, not by a listing.** After creating an issue, comment or pull
  request, fetch it directly. `gh issue list` served stale reads during a GitHub incident and a
  duplicate got filed. **The duplicate's number was never recorded.** This bullet used to send the
  reader to `issue-tracker.md` for it, which holds no account of it either — the two files pointed
  at each other and neither recorded the incident (#227). The only account is #97's list of what
  this file was carrying when it came out of a session scratchpad on 2026-09-24. Two pairs of
  tickets were filed within two minutes of each other on 2026-09-15 and reconciled by hand within
  the next minute (#18 superseded by #20, #21 a duplicate of #19), and nothing ties either pair to
  a stale listing, so neither is named here as the occurrence.
- **Never claim a CI or pull request state you have not just fetched.** Runs take a couple of
  minutes to appear, and "no runs at all" was wrong twice because it was read too early.
  **Neither occurrence is recorded anywhere but here**: the line arrived with the rest of this file
  on 2026-09-24 (PR #98), and #97's own list of what it was carrying does not name it.
- **`npm install` in a worktree warns that some packages have install scripts not covered.**
  That warning is expected — esbuild — and `--ignore-scripts` is deliberate
  (`CLAUDE.md`, "Code guardrails"). Do not "fix" it and do not approve the scripts.
- **Measure the test baseline on clean `dev` at dispatch time** and put the number in the brief.
  Hardcoding it here guarantees it is wrong by the next merge. If a run sees fewer test files
  than that baseline plus its own, the run is wrong, not the repo.
- **Re-check your invocation before reporting a tool broken.** An esbuild check was once called
  broken because a string had been passed where an options object belonged. **Not recorded anywhere
  but here either**, and for the same reason as the CI-state line above: it came in with PR #98 and
  is not in #97's list. Both are kept because the behaviour happened, and marked because a reader
  following them finds nothing.

## Reporting, and running out of budget

Say what you did, why, what you measured, what you deliberately did not do, and anything you
found that belongs in a separate ticket. If an acceptance criterion is unmet, say so; if you
could not measure something, say that rather than implying you did. A wrong claim in a pull
request body costs more to undo than an open question costs to answer.

Budget is finite and it does not protect your progress — pushing does. Commit in coherent steps
as you go. If you are going to run out, **push what you have, open a draft pull request, and say
exactly where you stopped.** An agent once died mid-ticket and left a pushed commit with no pull
request and no note, which cost more to reconstruct than the ticket had cost to write. #97 records
it; the run is not named there.

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
rewritten every run and read once, under load, and then it is gone: briefs are written into an
agent's prompt, and nothing in this repository can be made to point at one. A briefing is not a
substitute for this file. The `git checkout -- <file>` hazard above is the case in point — three
agents met it across two runs while this file still did not carry the line, and each had to
notice and recover from it unaided. If a run learns something the next run needs, it belongs
here, and the pull request that learned it is the cheapest place to propose the line.

## Rules that live elsewhere, and are not repeated here

- The code guardrails, the `--ignore-scripts` rule and the branching model — `CLAUDE.md`
- Frozen ticket bodies, and amendments as comments — `issue-tracker.md`
- How big a ticket is, and composition as a parent plus sub-issues — `issue-tracker.md`
- Why a worktree at all, and how to create and remove one — `worktrees.md`
- The vocabulary code and commits must use — `CONTEXT.md`
- Crawled data staying out of this repo — ADR-0006, and `CLAUDE.md`
