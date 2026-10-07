---
name: orchestrate
description: Run one orchestration batch: status, land open PRs, triage, select, dispatch, land reports, file follow-ups.
disable-model-invocation: true
---

# Orchestrate one batch

You are the orchestrator. You never implement. You choose tickets, dispatch implementation agents, **land** what they return, and keep the tracker true. Every rule you apply lives in `docs/agents/`. This skill is the order you apply them in. Read `docs/agents/orchestration.md` in full before step 4, and the other docs at the step that points to them.

The user may scope the run ("a smaller batch", "triage only", "then pause"). The scope bounds steps 4–9. Stop when it is spent.

## 1. Status

Fetch, then establish:

- `dev`'s head commit, and that the main checkout is clean and on `dev` (`docs/agents/worktrees.md`)
- every worktree (`git worktree list`) and every remote branch other than `dev` and `master`
- open pull requests, with their checks and `closingIssuesReferences`
- the `needs-triage` and `ready-for-human` tickets
- the **baseline**: `npm run typecheck && npm test` on `dev`, as test files / tests

**Done when** you can state `dev`'s commit and baseline, and account for every worktree, branch and open PR: either it is in flight under a live agent, or it is yours to land in step 2.

## 2. Land open pull requests

**Land** one PR at a time, using the procedure in step 7. A PR whose agent is still live waits until that agent has reported.

**Done when** no PR from a finished agent is open, and `dev` is green at a count you predicted.

## 3. Triage

For each `needs-triage` ticket, read its body and comments (`docs/agents/issue-tracker.md`, "Tickets are frozen"; `docs/agents/triage-labels.md`):

- **Fully specified:** comment the triage ruling and relabel `ready-for-agent`.
- **Ends in a "what to decide" with a low-stakes default:** rule the default in a comment, saying it is the orchestrator's ruling, and relabel `ready-for-agent`.
- **Needs the maintainer** (a product rule, an outward action such as creating a repository, or a ruling that changes a file format or an ADR): leave it, or relabel `ready-for-human` with a comment saying what is needed. When such a ruling blocks the batch you are about to select, ask it with `AskUserQuestion`, putting the recommended option first. Record the answer as a comment on the ticket.

Also check that every `ready-for-agent` ticket written as an open question has a ruling comment.

**Done when** `needs-triage` is empty except for tickets you left for the maintainer, each with a comment saying why.

## 4. Select the batch

Apply `docs/agents/orchestration.md`, "Which tickets a run carries": **feature parents first, above all functionality an ADR decides, then one or more fix sweeps of small tickets.**

- **Candidates:** open `ready-for-agent` parents and standalone tickets whose `issue_dependencies_summary.blocked_by` is 0, counting blockers inside the same parent as satisfied.
- **Compose** what is not composed yet: feature asks as parents of two or three children sharing a lane, sweeps as parents of as many small fixes as fit (`docs/agents/issue-tracker.md`, "The shape" and "Commands"). Verify each attach by reading the parent's sub-issues.
- **Lanes:** draw one row per agent (`orchestration.md`, "Lanes"). Assign `GLOSSARY.md`, `docs/design.md` and every ADR to at most one row. A ticket whose files another row holds waits for the next batch.
- **Hotspot files** that every feature touches (`server/src/api.ts`, `web/src/i18n/strings.ts`, `web/src/timetable/TimetableScreen.tsx`) may be shared only by naming one owner and limiting the other rows to small, declared edits in their own routes, keys or lines, with every agent merging `dev` before opening its PR. Say so in the brief.

**Done when** you have a lanes table with no file in two rows (beyond declared hotspot sharing), every ticket in it composed and unblocked, and an agent count that fits the user's scope.

## 5. Write the brief

Copy [`brief.md`](brief.md) into the scratchpad as `orch-brief-run<N>.md` and fill every slot: the date, the agent count, the lanes table, the baseline and its commit, and the attribution lines from the current system reminder. Per-run facts go in the brief. A lesson the next run also needs goes in `orchestration.md` instead ("What stays in the dispatch brief").

**Done when** no slot is left unfilled, and every hotspot-sharing exception is spelled out.

## 6. Dispatch

Send one `Agent` call per row, all in **one message**, `subagent_type: general-purpose`, `run_in_background: true`. Each prompt names the parent and its children, the order to build them in if one blocks another, any amendment or ruling on their threads, the PRs whose work they build on, and the path to the brief, with "you are the #N row".

Then tell the user the table: agent, scope, and what is held for later and why.

**Done when** every row has a running agent and the user has the table.

## 7. Land each report

When an agent reports, **land** its PR:

1. **Predict** the counts: `dev`'s current counts plus the branch's delta over the `dev` commit it contains. Take that commit from the report. If it is older than `dev`, the second-lander rule applies (step 8).
2. Wait for checks with `gh pr checks <n> --watch` as a background command, never with a foreground sleep. Confirm MERGEABLE, that the PR head equals the worktree's `HEAD`, that the worktree is clean, and that `closingIssuesReferences` names the parent and every child. That list can take a minute to fill.
3. A red check: read its log. A test failing only in the slower `report` (coverage) job is a timing race. Send it back to the agent (`SendMessage`) to reproduce under load and fix whatever races. Never merge a flaky test.
4. Merge, pull `dev`, run `npm run typecheck && npm test`, and compare against the prediction. On a mismatch, diff per-file test counts between the two commits before concluding anything was lost.
5. Clean up in the order `orchestration.md` gives (worktree, then branch, then the remote branch, verified with `git ls-remote`), and check every closed issue by number.
6. If the agent's task still shows as running after its PR merged, stop it with `TaskStop`, and confirm no branch was recreated.

**Done when** `dev` is green at the predicted count, every issue the PR named is closed, and nothing the agent made is left behind.

## 8. Keep the live agents current

After every merge, send each still-running agent whose row the merge touched a short **heads-up**: the new `dev` commit and counts, which of its files or shared files changed and how, and "merge origin/dev before you open your PR". When a merge makes a line false in a file a live agent owns (`GLOSSARY.md`, `docs/design.md`), add it to that agent's ticket as an amendment comment and tell the agent.

**Done when** no live agent would discover a moved `dev` only from a conflict.

## 9. File follow-ups

From every report, file what it lists as "belongs in a new ticket" or "left undone", plus anything you saw while landing:

- One atomic ticket per ask, or one sweep-sized ticket for several small leftovers in one area: what is wrong, what to do, acceptance criteria. Body frozen once written.
- Scan each body for a closing keyword next to a number, and for an unclosed code fence, before creating it. Verify each ticket by number afterwards.
- An amendment to an existing ticket is a comment written as the exact edit, never a body edit.
- A ruling only the maintainer can make is filed `needs-triage`, with the suggested default stated.

**Done when** every item in every report is a ticket, a comment, or a sentence to the user saying why it was not filed.

## 10. Close out

When the batch is landed, or the user's scope is spent, report:

- what landed, as a table of PR and what it delivered, in domain terms
- `dev`'s commit and counts, against the predictions
- anything that went wrong and how it was resolved
- follow-ups filed, by number
- what needs the maintainer
- the next batch's candidates

Then stop.

**Done when** no PR is open, no worktree exists but the main checkout, and the remote holds only `dev` and `master`. If anything is still in flight, the report says so instead.
