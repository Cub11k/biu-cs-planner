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
 * **It also reads the body, for the half the list cannot show (#308).** Starting from the list
 * means a `Closes` line GitHub never recorded leaves nothing to compare — #223's failure, where
 * four deliberate lines registered as none. So the body is searched for closing keywords before
 * an issue number (`writtenClosings`), and any it finds that the list lacks are named. The body
 * is never where the answer comes from: it is only what the list is checked against.
 *
 * **It advises and never gates.** A pull request may close two of a parent's three children
 * on purpose, and a check that can be wrong for a good reason belongs in a comment a reader
 * can weigh, not in a red job. So nothing here throws past `run`, and a pull request whose
 * body and list agree and that leaves no child of a listed parent open hears nothing at all.
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

/**
 * The body with every fenced code block, inline code span and HTML comment blanked out, which is
 * where GitHub parses no references at all — and where `docs/agents/issue-tracker.md` tells an
 * author to put a quotation that carries a keyword, so reading it there would flag the very thing
 * that advice makes safe.
 *
 * A fence is three or more backticks or tildes, indented at most three spaces, closed by a run
 * of the same character at least as long with nothing after it but spaces, or by the end of the
 * body. A code span is a run of backticks closed by a run of exactly the same length within the
 * same paragraph, so a stray backtick cannot hide a `Closes` line paragraphs later. That is
 * CommonMark's rule for both. An HTML comment runs from `<!--` to `-->`, or to the end of the
 * body. Indented code blocks are not handled, and a reference in one is read as written.
 */
export function proseOnly(body: string): string {
  return blankCode(fences(body).kept);
}

/**
 * The body's lines with every fenced line blanked, and the line (1-based) of a fence that is
 * never closed, if there is one.
 */
function fences(body: string): { kept: string[]; openAt?: number } {
  const kept: string[] = [];
  let fence: { char: string; length: number; line: number } | undefined;
  const lines = body.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (fence) {
      const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (closer && closer[1]![0] === fence.char && closer[1]!.length >= fence.length) {
        fence = undefined;
      }
      kept.push("");
      continue;
    }
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opener) {
      fence = { char: opener[1]![0]!, length: opener[1]!.length, line: index + 1 };
      kept.push("");
      continue;
    }
    kept.push(line);
  }
  return fence ? { kept, openAt: fence.line } : { kept };
}

function blankCode(kept: readonly string[]): string {
  // A blanked fence line is an empty line, so it ends a paragraph as the fence did. Code spans
  // go before comments: a marker quoted in backticks — `<!-- pr-review -->` — is code, and read
  // as a comment opener it would blank everything after it.
  return kept
    .join("\n")
    .split(/(\n[ \t]*\n)/)
    .map((part) => part.replace(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " "))
    .join("")
    .replace(/<!--[\s\S]*?(?:-->|$)/g, " ");
}

/**
 * GitHub's documented closing keywords, each followed by an issue: `#n`, or `owner/repo#n` when
 * that is this repository. A colon after the keyword is allowed, as GitHub allows it.
 *
 * A literal, and nothing is built from data (ADR-0007): the keywords are GitHub's list, written
 * out. The `\b` in front is what keeps `enclosed #5` from reading as `closed #5`, and it does not
 * keep `the closed #125` out — nor should it, since GitHub registered exactly that phrase on
 * #223 (`docs/agents/issue-tracker.md`).
 */
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \t]+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;

/**
 * The issue numbers the body puts a closing keyword in front of, in this repository, outside
 * code, each once and in the order first written.
 *
 * An issue in another repository is left out, as `main.ts` leaves it out of the list: its
 * number means nothing here.
 */
export function writtenClosings(body: string, repository: string): number[] {
  const found = new Set<number>();
  for (const match of proseOnly(body).matchAll(CLOSING)) {
    const elsewhere = match[1];
    if (elsewhere !== undefined && elsewhere.toLowerCase() !== repository.toLowerCase()) continue;
    found.add(Number(match[2]));
  }
  return [...found];
}

/**
 * A code fence that is never closed, and the closing keywords it swallowed.
 *
 * CommonMark runs an unclosed fence to the end of the body, so every `Closes` line after it is
 * code and GitHub registers none of them — while the author, who meant the fence to end, sees
 * prose. That is what happened on #223: a fence quoting another fence (```` ```ts ```` inside
 * ```` ``` ````) closed early, the next ```` ``` ```` opened a new one, and the four deliberate
 * lines at the bottom fell inside it. `writtenClosings` rightly skips them, so this reads the
 * swallowed text as if the fence were not there, to say what was lost and where.
 */
export type OpenFence = { readonly line: number; readonly hidden: readonly number[] };

export function openFence(body: string, repository: string): OpenFence | undefined {
  const { openAt } = fences(body);
  if (openAt === undefined) return undefined;
  const after = body.split(/\r?\n/).slice(openAt).join("\n");
  const hidden = writtenClosings(after, repository);
  return hidden.length > 0 ? { line: openAt, hidden } : undefined;
}

/** What the body closes that GitHub's list does not hold, in the body's order. */
export function unregistered(written: readonly number[], listed: readonly number[]): number[] {
  const recorded = new Set(listed);
  return written.filter((n) => !recorded.has(n));
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
 * The comment for a pull request with findings. The first sentence of each part is the whole
 * finding, written so that it can be acted on without opening anything: which issues the list
 * holds, and which children of which parent it does not; then which issues the body closes that
 * the list does not hold.
 *
 * With nothing `unwritten`, the comment is word for word what it was before the body was read,
 * so a comment already on a pull request is not edited for a change in this file.
 */
export function renderFindings(
  closes: readonly number[],
  findings: readonly Finding[],
  unwritten: readonly number[] = [],
  fence?: OpenFence,
  cutAt?: number,
): string {
  const out = [MARKER, "", "### Closing references", ""];

  if (cutAt !== undefined) {
    out.push(
      `**GitHub holds more closing references than this check reads: it read the first ` +
        `${cutAt} and stopped.** Everything below is judged against those alone, so a child ` +
        "named as left out, or a line named as unregistered, may be in the part it did not read.",
      "",
    );
  }

  if (findings.length > 0) {
    const sentences = findings.map(
      (finding) =>
        `${issueList(finding.missing)} ${finding.missing.length === 1 ? "is an open child" : "are open children"} ` +
        `of #${finding.parent} and ${finding.missing.length === 1 ? "is" : "are"} not in the list.`,
    );
    const add = findings
      .flatMap((finding) => finding.missing)
      .map((n) => `\`Closes #${n}\``)
      .join(", ");
    out.push(
      `This pull request closes ${issueList(closes)}; ${sentences.join(" ")}`,
      "",
      "If that is not deliberate, add " +
        add +
        " to the body, each on its own line with the keyword repeated, as " +
        "`docs/agents/issue-tracker.md` describes. If it is — this pull request closes only " +
        "some of the children — nothing needs doing: this is advice, and it never fails a job.",
      "",
    );
  }

  if (unwritten.length > 0) {
    const one = unwritten.length === 1;
    out.push(
      `The body puts a closing keyword before ${issueList(unwritten)}, and GitHub's list ` +
        `${closes.length === 0 ? "holds no issue at all" : `holds ${issueList(closes)}`}, so ` +
        `merging will not close ${one ? "it" : "them"}.`,
      "",
      "Lines written on purpose that GitHub never registered are a failure " +
        "`docs/agents/issue-tracker.md` records. Edit the body and read the list again, and if it " +
        `still disagrees, close ${one ? "it" : "them"} by hand after the merge with the reason. ` +
        "If the number is a pull " +
        "request rather than an issue, GitHub records no closing reference to it and nothing " +
        "needs doing: this is advice, and it never fails a job.",
      "",
    );
  }

  if (fence) {
    const one = fence.hidden.length === 1;
    out.push(
      `The code fence opened on line ${fence.line} of the body is never closed, so GitHub reads ` +
        `everything after it as code, including the closing keyword${one ? "" : "s"} before ` +
        `${issueList(fence.hidden)}, and merging will not close ${one ? "it" : "them"}. A fence ` +
        "quoting another fence ends at the inner one's closing line; close it, or quote with a " +
        "longer fence (four backticks around three), and this comment resolves on the next edit.",
      "",
    );
  }

  const bodyRead = unwritten.length > 0 || fence !== undefined;
  out.push(
    !bodyRead
      ? `Read from what GitHub recorded (${VERIFY}), not from the body, and re-read on every ` +
          "edit and push."
      : `Compared against what GitHub recorded (${VERIFY}) — the body is read only for lines ` +
          "the list is missing, never instead of it — and re-read on every edit and push.",
  );
  return out.join("\n");
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
        ? `This pull request closes ${issueList(numbers)}, and ${numbers.length === 1 ? "it is not a parent" : "none of them is a parent"}.`
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
 * is already there no longer says the right thing; otherwise stay silent. A pull request with
 * no listed parent's child left out, no closing line in its body that the list lacks, a list
 * read to its end, and no earlier comment is always silent.
 */
export function decide(
  closes: readonly Closed[],
  existing: Existing | undefined,
  unwritten: readonly number[] = [],
  fence?: OpenFence,
  cutAt?: number,
): Decision {
  const numbers = closes.map((issue) => issue.number);
  const findings = unclosedChildren(closes);
  // A list read short is a finding of its own: everything else here was judged against part
  // of what GitHub holds, so saying nothing would pass a part off as the whole (#320).
  const anything =
    findings.length > 0 || unwritten.length > 0 || fence !== undefined || cutAt !== undefined;

  if (!anything && !existing) return { kind: "silent" };

  const body = anything
    ? renderFindings(numbers, findings, unwritten, fence, cutAt)
    : renderResolved(closes);

  if (!existing) return { kind: "post", body };
  if (existing.body === body) return { kind: "silent" };
  return { kind: "edit", id: existing.id, body };
}

/** The GitHub side, for one pull request. */
export interface Port {
  /** `owner/name`, for telling this repository's `owner/name#n` from another's. */
  readonly repository: string;
  /**
   * The issue numbers in the pull request's `closingIssuesReferences`, every page of them, and
   * `cutAt` — how many were read — only when the read stopped at its page cap with more left
   * (#320). Absent means `numbers` is the whole list.
   */
  closingReferences(): Promise<{ numbers: number[]; cutAt?: number }>;
  /**
   * The body, where GitHub would read closing keywords from it — and `""` where it would not:
   * GitHub links closing keywords only on a pull request into the default branch, so a release
   * pull request into `master` carries `Closes` lines that were never meant to register.
   */
  body(): Promise<string>;
  /** One issue's sub-issues, with whether each is open. */
  subIssues(issue: number): Promise<Child[]>;
  /** This check's comment on the pull request, found by `MARKER` and its author (`POSTER`). */
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
    const { numbers, cutAt } = await port.closingReferences();
    const body = await port.body();
    const unwritten = unregistered(writtenClosings(body, port.repository), numbers);
    // Only what the list lacks: a swallowed line GitHub registered anyway is no loss.
    const swallowed = openFence(body, port.repository);
    const hidden = swallowed ? unregistered(swallowed.hidden, numbers) : [];
    const fence = swallowed && hidden.length > 0 ? { line: swallowed.line, hidden } : undefined;
    const closes = await Promise.all(
      numbers.map(async (number) => ({ number, children: await port.subIssues(number) })),
    );
    const decision = decide(closes, await port.findComment(), unwritten, fence, cutAt);

    if (decision.kind === "post") await port.postComment(decision.body);
    if (decision.kind === "edit") await port.editComment(decision.id, decision.body);

    if (cutAt !== undefined) {
      log(`::warning::closing-references check read only the first ${cutAt} closing references`);
    }
    log(
      `closes ${numbers.length === 0 ? "nothing" : issueList(numbers)}; ` +
        `${unclosedChildren(closes).length} parent(s) with open children not listed; ` +
        `${unwritten.length} closing line(s) in the body not listed; ` +
        `${fence ? `an unclosed fence from line ${fence.line} hides ${issueList(fence.hidden)}` : "no unclosed fence hiding one"}; ` +
        `${decision.kind}`,
    );
    return decision;
  } catch (error) {
    // `::warning::` is a workflow command: Actions shows it on the run's summary page.
    log(`::warning::closing-references check did not finish: ${String(error)}`);
    return undefined;
  }
}
