/**
 * Which open tickets name a path (#385): the lookup behind `issue-tracker.md`'s lane test and
 * `orchestration.md`'s sequencing, which used to be a read of every open issue by hand.
 *
 * Every ticket names its files in prose — a "Lane" section, paths in "What to do" — and an
 * amendment in the thread can add more, so a body and every comment are read. A path is found as
 * a **path-shaped token** and compared as a literal string: nothing here builds a pattern from what
 * an issue says (`CLAUDE.md`, "Code guardrails"). A directory argument matches any path under it,
 * a file argument matches a folder a ticket names above it, and both only at a `/`, so `web/src/plan` does not match `web/src/planDiffs.ts`.
 *
 * **A path's tail matches too**, because tickets write a folder once and its files after it —
 * "`app/src`: `edit.ts`, `plan.ts`, …" (#376) — so `plan.ts` names `app/src/plan.ts`. The cost is
 * that it names every other `plan.ts` as well; the line is printed beside each hit, so a reader
 * can tell.
 *
 * Pure; `main.ts` reads the tracker through `gh` and prints.
 */

/** One open issue as the tracker gives it: body, comments, and the parent it is a sub-issue of. */
export type Issue = {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly comments: readonly string[];
  /** The open parent this issue is a sub-issue of, when it has one. */
  readonly parent?: number;
};

/** A line of an issue that names the path, and where it is. */
export type Hit = { readonly where: "body" | `comment ${number}`; readonly line: string };

/** An issue that names the path, with the lines that do. */
export type Match = { readonly number: number; readonly title: string; readonly hits: readonly Hit[] };

/** A top-level issue in the answer, with its sub-issues that matched (it may not have itself). */
export type Group = Match & { readonly children: readonly Match[] };

/** Characters a path in a ticket is written with; anything else ends the token. */
const PATH_CHARACTERS = /[A-Za-z0-9._\/@-]+/g;

/**
 * `./x/` and `x` are one path, and a sentence's full stop is not part of one. A `:704` line
 * suffix never reaches here: `:` is not a path character.
 */
const normalise = (path: string): string =>
  path
    .replace(/^\.\//, "")
    .replace(/\.+$/, "")
    .replace(/\/+$/, "");

/** The path-shaped tokens of one line: a `/` or a `.` inside, and not only dots. */
export const pathTokens = (line: string): string[] =>
  (line.match(PATH_CHARACTERS) ?? [])
    .map(normalise)
    .filter((token) => /[A-Za-z0-9]/.test(token) && /[/.]/.test(token));

/**
 * Whether a token names the path, something under it, a folder holding it, or the path's tail
 * from a `/` on, by plain string comparison. A ticket that names a folder holds every file in it.
 */
export const names = (token: string, path: string): boolean =>
  token === path ||
  token.startsWith(`${path}/`) ||
  path.startsWith(`${token}/`) ||
  path.endsWith(`/${token}`);

const hitsIn = (where: Hit["where"], text: string, path: string): Hit[] =>
  text
    .split("\n")
    .filter((line) => pathTokens(line).some((token) => names(token, path)))
    .map((line) => ({ where, line: line.trim() }));

/** The issue's lines naming `path`, body first and then each comment in order. */
export const hitsOf = (issue: Issue, path: string): Hit[] => [
  ...hitsIn("body", issue.body, path),
  ...issue.comments.flatMap((comment, index) =>
    hitsIn(`comment ${index + 1}`, comment, path),
  ),
];

/**
 * The open issues naming `path`, grouped so that a sub-issue is shown under its parent. A parent
 * that is open but did not match is shown with no hits of its own, so its matched children still
 * read as part of it; a sub-issue whose parent is not among the open issues stands on its own.
 */
export function lanes(path: string, issues: readonly Issue[]): Group[] {
  const target = normalise(path);
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const matched = issues
    .map((issue) => ({ issue, hits: hitsOf(issue, target) }))
    .filter(({ hits }) => hits.length > 0);

  const groups = new Map<number, { match: Match; children: Match[] }>();
  /** A parent's hits are its own whether it is reached first or through a child. */
  const groupOf = (issue: Issue, hits: readonly Hit[]) => {
    const existing = groups.get(issue.number);
    if (existing !== undefined) return existing;
    const made = { match: { number: issue.number, title: issue.title, hits }, children: [] };
    groups.set(issue.number, made);
    return made;
  };

  for (const { issue, hits } of matched) {
    const parent = issue.parent === undefined ? undefined : byNumber.get(issue.parent);
    if (parent === undefined) {
      groupOf(issue, hits);
    } else {
      groupOf(parent, hitsOf(parent, target)).children.push({
        number: issue.number,
        title: issue.title,
        hits,
      });
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.match.number - b.match.number)
    .map(({ match, children }) => ({
      ...match,
      children: children.sort((a, b) => a.number - b.number),
    }));
}

/** The answer for each path, as text a terminal shows. */
export function render(answers: readonly { path: string; groups: readonly Group[] }[]): string {
  const hitLines = (hits: readonly Hit[], indent: string): string[] =>
    hits.map((hit) => `${indent}${hit.where}: ${hit.line}`);

  return answers
    .flatMap(({ path, groups }) => [
      path,
      ...(groups.length === 0 ? ["  no open issue names it"] : []),
      ...groups.flatMap((group) => [
        `  #${group.number} ${group.title}`,
        ...hitLines(group.hits, "      "),
        ...group.children.flatMap((child) => [
          `    #${child.number} ${child.title} (sub-issue of #${group.number})`,
          ...hitLines(child.hits, "        "),
        ]),
      ]),
      "",
    ])
    .join("\n");
}
