/**
 * Whether a pull request that closes a composed parent also closes that parent's open
 * children, read from what GitHub recorded rather than from the body that was written.
 *
 * `docs/agents/issue-tracker.md` asks for this by hand after every pull request is opened:
 * `gh pr view <n> --json closingIssuesReferences` should list the parent and every child.
 * The failure it catches is silent — a parent closes on merge, its children stay open, and
 * the tracker then lists merged work as still to do (#191, #205). This is that step, run on
 * every pull request so that the answer is on the thread before anyone merges (#260).
 *
 * **It advises and never gates.** A pull request may close two of a parent's three children
 * on purpose, and a check that can be wrong for a good reason belongs in a comment a reader
 * can weigh, not in a red job. So nothing here throws past `run`, and a pull request that
 * closes no parent hears nothing at all.
 *
 * Everything below `run` is pure; `run` takes its GitHub side as a `Port`, so the decision
 * of what to say — and when to say nothing — is tested without a network. `main.ts` is the
 * real port and nothing else.
 */

/** Finds this check's comment among the others on a pull request. */
export const MARKER = "<!-- closing-references -->";

/** One sub-issue of an issue the pull request closes. */
export type Child = { readonly number: number; readonly open: boolean };

/** One issue in the pull request's closing references, with its sub-issues (often none). */
export type Closed = { readonly number: number; readonly children: readonly Child[] };

/** A parent the pull request closes, and the open children of it that it does not. */
export type Finding = { readonly parent: number; readonly missing: readonly number[] };

/**
 * Every parent in the list with an open child that is not in the list, in the order GitHub
 * listed the parents. A closed child is not missing: there is nothing left for a merge to
 * close. An issue with no sub-issues is no parent and is never a finding.
 */
export function unclosedChildren(closes: readonly Closed[]): Finding[] {
  const listed = new Set(closes.map((issue) => issue.number));
  return closes.flatMap((issue) => {
    const missing = issue.children
      .filter((child) => child.open && !listed.has(child.number))
      .map((child) => child.number);
    return missing.length > 0 ? [{ parent: issue.number, missing }] : [];
  });
}

/** `#1`, `#1 and #2`, `#1, #2 and #3`. */
export function issueList(numbers: readonly number[]): string {
  const refs = numbers.map((n) => `#${n}`);
  if (refs.length <= 1) return refs.join("");
  return `${refs.slice(0, -1).join(", ")} and ${refs[refs.length - 1]}`;
}

const VERIFY =
  "`gh pr view <n> --json closingIssuesReferences --jq '[.closingIssuesReferences[].number]'`";

/**
 * The comment for a pull request with findings. The first sentence is the whole finding,
 * written so that it can be acted on without opening anything: which issues the list holds,
 * and which children of which parent it does not.
 */
export function renderFindings(closes: readonly number[], findings: readonly Finding[]): string {
  const sentences = findings.map(
    (finding) =>
      `${issueList(finding.missing)} ${finding.missing.length === 1 ? "is an open child" : "are open children"} ` +
      `of #${finding.parent} and ${finding.missing.length === 1 ? "is" : "are"} not in the list.`,
  );
  const add = findings
    .flatMap((finding) => finding.missing)
    .map((n) => `\`Closes #${n}\``)
    .join(", ");

  return [
    MARKER,
    "",
    "### Closing references",
    "",
    `This pull request closes ${issueList(closes)}; ${sentences.join(" ")}`,
    "",
    "If that is not deliberate, add " +
      add +
      " to the body, each on its own line with the keyword repeated, as " +
      "`docs/agents/issue-tracker.md` describes. If it is — this pull request closes only " +
      "some of the children — nothing needs doing: this is advice, and it never fails a job.",
    "",
    `Read from what GitHub recorded (${VERIFY}), not from the body, and re-read on every ` +
      "edit and push.",
  ].join("\n");
}

/**
 * What an earlier finding becomes once nothing is missing any more. Edited in place rather
 * than deleted, so the thread still shows that something was flagged and then answered.
 */
export function renderResolved(closes: readonly Closed[]): string {
  const numbers = closes.map((issue) => issue.number);
  const now =
    numbers.length === 0
      ? "This pull request no longer closes any issue."
      : !closes.some((issue) => issue.children.length > 0)
        ? `This pull request closes ${issueList(numbers)}, and none of them is a parent.`
        : `This pull request closes ${issueList(numbers)}, and every open child of a parent ` +
          "among them is in that list.";
  return [MARKER, "", "### Closing references", "", `Resolved. ${now}`].join("\n");
}

/** One of the three things the check can do on a pull request. */
export type Decision =
  | { readonly kind: "silent" }
  | { readonly kind: "post"; readonly body: string }
  | { readonly kind: "edit"; readonly id: number; readonly body: string };

/** This check's own comment, if it has posted one. */
export type Existing = { readonly id: number; readonly body: string };

/**
 * Post when there is something to say and nowhere to say it yet; edit when the comment that
 * is already there no longer says the right thing; otherwise stay silent. A pull request
 * with nothing missing and no earlier comment — which includes every pull request that
 * closes no parent — is always silent.
 */
export function decide(closes: readonly Closed[], existing: Existing | undefined): Decision {
  const numbers = closes.map((issue) => issue.number);
  const findings = unclosedChildren(closes);

  if (findings.length === 0 && !existing) return { kind: "silent" };

  const body =
    findings.length > 0 ? renderFindings(numbers, findings) : renderResolved(closes);

  if (!existing) return { kind: "post", body };
  if (existing.body === body) return { kind: "silent" };
  return { kind: "edit", id: existing.id, body };
}

/** The GitHub side, for one pull request. */
export interface Port {
  /** The issue numbers in the pull request's `closingIssuesReferences`. */
  closingReferences(): Promise<number[]>;
  /** One issue's sub-issues, with whether each is open. */
  subIssues(issue: number): Promise<Child[]>;
  /** This check's comment on the pull request, found by `MARKER`. */
  findComment(): Promise<Existing | undefined>;
  postComment(body: string): Promise<void>;
  editComment(id: number, body: string): Promise<void>;
}

/**
 * Reads, decides and writes, and **never throws**: any failure — a token that cannot write
 * on a fork, an API outage, a rate limit — becomes a warning in the job log and the job
 * stays green. The returned decision is for the log and for tests.
 */
export async function run(
  port: Port,
  log: (line: string) => void,
): Promise<Decision | undefined> {
  try {
    const numbers = await port.closingReferences();
    const closes = await Promise.all(
      numbers.map(async (number) => ({ number, children: await port.subIssues(number) })),
    );
    const decision = decide(closes, await port.findComment());

    if (decision.kind === "post") await port.postComment(decision.body);
    if (decision.kind === "edit") await port.editComment(decision.id, decision.body);

    log(
      `closes ${numbers.length === 0 ? "nothing" : issueList(numbers)}; ` +
        `${unclosedChildren(closes).length} parent(s) with open children not listed; ` +
        `${decision.kind}`,
    );
    return decision;
  } catch (error) {
    // `::warning::` is a workflow command: Actions shows it on the run's summary page.
    log(`::warning::closing-references check did not finish: ${String(error)}`);
    return undefined;
  }
}
