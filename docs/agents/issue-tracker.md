# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Repo

`Cub11k/biu-cs-planner`, **public**, default branch `dev`; `master` holds releases only. The `origin` remote uses the
`github:` SSH alias from `~/.ssh/config`; `gh` resolves that to `github.com/Cub11k/biu-cs-planner`
correctly, so no `-R` flag is needed when running inside the clone.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v`; `gh` does this automatically when run inside a clone.

## Tickets are frozen

**Read issue bodies. Never write them.** A ticket is the record of what was asked for, and it is
what a reviewer reads an implementation against. Rewriting it to match what got built destroys the
only independent account of the original ask — the diff then agrees with the ticket by construction,
and nobody can tell whether the work met the request or the request was moved.

This holds even when the ticket has genuinely been superseded, and even when the new text would be
more accurate. Especially then: a superseded ticket plus a dated amendment is a decision with a
history, while a quietly corrected ticket is a decision with none.

Amendments, findings, corrections and open questions go in the **comment thread**, where they carry
a timestamp and an author and sit alongside the original instead of replacing it. When an amendment
changes what should be built, write it as the *exact edit* it would be — quote the lines it
replaces — so the ticket, the pull request and the implementation can be reconciled without anyone
guessing which is current.

Labels and assignees are not the body; change those freely. `gh issue edit --body` and
`--body-file` are for creating a ticket, not for revising one.

## How big a ticket is

**A ticket is two or three atomic asks that share a file lane, stated as one goal.** Three is a
cap, not a target. **It does not bind a fix sweep**, whose parent holds as many small fixes as the
sweep does, across lanes — `orchestration.md`, "Which tickets a run carries".

The habit this replaces was one atomic ask per ticket — a single defect, a single untested
function, a single wrong line in a record. Those tickets are sharp and each is reviewable against
its own diff, and nothing here asks for vaguer ones. What they cost is overhead: a worktree, an
`npm install`, a branch, a pull request, two reviewers and a merge are roughly fixed per ticket, so
the smaller the ticket the worse the ratio. Worse, two atomic asks in the same file get sequenced
across days instead of being fixed in one pass by someone already holding the context, and the
second one pays to rebuild it.

### The shape: a parent with the atomic tickets as sub-issues

The parent ticket states the composed goal. The atomic tickets become its GitHub sub-issues and
**nothing in their bodies is touched** — composing is additive, which is why it was chosen over a
ticket that quotes its predecessors and closes them as superseded. That alternative would move the
ask into a body written after the fact, which is the thing "Tickets are frozen" exists to prevent.
A parent adds a layer; it does not replace one.

A parent body carries the goal, the lane, which child contributes what, acceptance criteria that
span the children, and what is out of scope. It does **not** restate the children's asks. They are
one click away and they are the frozen record; a paraphrase in the parent is a second version of
the ask that can drift from the first.

**One worktree, one branch, one pull request per parent.** The saving is the overhead, so a parent
that lands as three pull requests has saved nothing.

**The pull request body closes the parent and every child, with the keyword repeated:**

```
Closes #179
Closes #124
Closes #125
```

Not `Closes #179, #124, #125`. GitHub reads one keyword as governing one reference and treats the
rest of a comma-separated list as ordinary links, so that spelling closes the parent and leaves
every child open. This file said it the wrong way for one day: #190 was the first parent to land
under this rule, it carried `Closes #178, #163, #176`, and on merge #178 closed while #163 and
#176 stayed open and had to be closed by hand (#191).

A parent closed over open children is worse than one that never claimed to close them — the open
count is wrong, `ready-for-agent` lists work that has already merged, and the next reconciliation
pass reads those children as still to do. It also wastes the one mechanical benefit the shape has:
`sub_issues_summary.completed` only moves when a child actually closes.

The keywords work in a pull request **body** and in commit messages, not in a comment added
afterwards, and only for issues in the same repository.

This is the same sub-issue machinery the wayfinding section below uses, for a different purpose. A
composed parent is not a `wayfinder:map`: a map is a standing document with Fog and
Decisions-so-far that outlives its children, while a parent is one unit of work that closes with
them.

### Verify the links from GitHub, not from the body you wrote

Once the pull request exists, ask GitHub what it recorded:

```sh
gh pr view <n> --json closingIssuesReferences --jq '[.closingIssuesReferences[].number]'
```

The expected answer is the parent and every child. The body is an input; this list is the state,
and the two can disagree — the same distinction "Verify a creation by number, not by a listing" in
`orchestration.md` draws, one level in.

**CI now asks this question too, and the manual step stays.** `closing-refs.yml` runs on every
pull request from a branch of this repository (forks are skipped: their token cannot comment), on
open, on every body edit and on every push, and comments on two things: when the list holds a
parent, any open child of it that the list does not hold (#260); and any issue the body puts a
closing keyword before, outside code fences and inline code, that the list does not hold — #223's
failure, described below, which starting from the list alone could not see (#308). It never fails
a job and says nothing while the body and the list agree and no listed parent has a child left
out. It skips only fences and inline code, so a keyword in an indented code block or an HTML
comment is still read, and may be named when GitHub rightly ignored it; the body of a pull request into any branch but `dev` is not read, because GitHub links no closing
keyword there; and nothing re-runs it when the tracker changes under an open pull request (a child
attached or reopened later is seen on the next push or body edit). So run the command above
yourself before reporting; the comment is a second reader, not a replacement. Run over the sixty
most recent pull requests on 2026-10-05, the body half named exactly one: #223, with the four
issues its `Closes` block was written for.

**The spelling being right is not the link being right.** On 2026-10-04 PR #223 carried `Closes
#205`, `Closes #202`, `Closes #203` and `Closes #204`, each with the keyword on its own line and
outside any code fence, and none of its six commit messages put a closing keyword before a number.
GitHub registered it as closing exactly one issue, the already-closed **#125**, and the four
written on purpose were not among them. Re-writing the body did not change it, and the parent and
its three children had to be closed by hand after the merge, with the reason on each (#205, #202,
#203, #204). The other pull requests merged in the same batch registered correctly — #221 its
parent #201 and all three children, #222 its parent #209 and all three, #224 its parent #181 and
both, and #220 the one parentless ticket (#213) it closed — so this was one pull request's links,
not a rule that does not work. #191's spelling rule stands unchanged; checking the list is the
step it never covered.

**A closing keyword in ordinary prose is a closing reference too, and may displace yours.** #223's
body carries, at its line 12 and some two hundred lines above its `Closes` block, the words `the
closed` with `#125` immediately after them, mid-sentence and reading as an adjective: "a dated
amendment on the closed #125, which is why #202 exists". `closed` is one of GitHub's keywords, so
that phrase — not a keyword-free mention, which is what the note on #205's thread calls it — is
where the #125 link came from. Across the five pull requests merged in that batch, #223 is the
only one whose body held a keyword-and-number pair anywhere before its `Closes` block, and the
only one whose `Closes` block did not register; the pair that *did* register is that phrase. One
run of five is a correlation and not a mechanism, and GitHub documents no such limit, so **treat
it as a reason to look rather than as a rule**: before opening a pull request, read the body for a
keyword that has landed next to a number by accident, and rephrase it so the two are not adjacent.
Quoting this very paragraph is the easy way to do it by mistake — put a quotation like that inside
a code fence, where no reference is parsed at all.

**When the list disagrees with the body, close the missing issues by hand after the merge**, with
the reason on each, as #202 through #205 record. Do not wait for a re-parse to repair it, and do
not carry the conclusion to the next pull request in either direction: check its list too.

### The lane test

Two atomic asks belong in one ticket when **the files they would write overlap, or sit in the same
module**. Not when they merely share a subsystem, and not when they would merely read well together
— the lane is the test because a composed ticket then *is* one lane in the sense
`orchestration.md` means, and the unit the tracker shows is the unit an agent is dispatched on.

**Lanes between parents will intersect, and that is not a defect in the grouping.** This repo is
small: `server/src/api.ts` and `docs/design.md` are each named by five or more open tickets at the
time of writing, and no grouping of them is disjoint. So two parents whose lanes intersect are
never dispatched at the same time — the dispatch brief sequences them, exactly as it would two
agents that wanted one file. Do not answer an intersection by splitting a parent back into atoms;
that trades a scheduling constraint for the overhead this rule exists to remove.

### Compose asks that are equally ready

**Where a lane holds both specified asks and asks waiting on a ruling, group the specified ones
together and leave the rulings to a parent of their own.** A parent is only as dispatchable as its
least-ready child, so composing one of each buys nothing and costs the specified ask its turn.

This is not the same as the asks being badly written. A `needs-triage` ticket in this repo is
usually complete prose ending in "What to decide" — `#145` sets out both readings of a bound and
says which questions the ruling has to answer. What it waits on is a judgement the author makes,
not a sentence an implementer could supply, and no amount of grouping shortens that wait.

### When there is nothing to compose with

An atomic ask that shares a lane with nothing ships as its own ticket, with no parent and no
apology. `ready-for-human` tickets are usually in this position, and so is whatever is left when a
reconciliation pass runs out of partners. Holding a specified ticket back until a partner appears
costs more than a small ticket does.

### Labels

**The parent carries the triage label that gates the work.** Children keep the label they were
filed with, and where the two disagree the parent's is the one dispatch reads. A parent is
`ready-for-agent` only when every child is specified well enough to build; one `needs-triage` child
makes the parent `needs-triage`, because the agent would stall on it either way.

### Commands

Confirmed against this repo by running them, except the detach, which is marked below — the one
line in this section that was written from the API's shape rather than from a run is the one that
turned out to be wrong, so the distinction is kept visible.

The sub-issues endpoint takes the child's numeric **database id**, not its `#number` and not its
`node_id`:

```sh
# the child's database id
gh api repos/Cub11k/biu-cs-planner/issues/<child> --jq .id

# attach — run, and the answer is the PARENT's number rather than the child's, so verify an
# attach by reading the parent's sub-issues below instead of by trusting the response
gh api --method POST   repos/Cub11k/biu-cs-planner/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>

# detach — NOT yet run here. No composition has needed undoing, and testing it would have meant
# either a throwaway ticket or detaching a closed parent's child, which leaves "removed sub-issue"
# on a finished record for nothing. Check the answer rather than assume it the first time it is used.
gh api --method DELETE repos/Cub11k/biu-cs-planner/issues/<parent>/sub_issue  -F sub_issue_id=<child-db-id>

# read the composition
gh api repos/Cub11k/biu-cs-planner/issues/<parent>/sub_issues --jq '.[] | {number, title, state}'
gh issue view <parent>   # prints the sub-issues and sub-issues-completed fields
gh issue view <child>    # prints the parent field
```

`gh issue list` does not show the parent/child relation, so a listing cannot tell you whether a
ticket is already composed. Check the ticket itself, as "Verify a creation by number, not by a
listing" in `orchestration.md` says for the same reason.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies**, the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only, the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me`, the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
