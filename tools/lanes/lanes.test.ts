import { describe, expect, it } from "vitest";
import { lanes, names, pathTokens, render, type Issue } from "./lanes.ts";

const issue = (number: number, body: string, comments: string[] = [], parent?: number): Issue => ({
  number,
  title: `ticket ${number}`,
  body,
  comments,
  ...(parent === undefined ? {} : { parent }),
});

const numbers = (path: string, issues: Issue[]): number[] =>
  lanes(path, issues).flatMap((group) => [group.number, ...group.children.map((c) => c.number)]);

describe("lanes", () => {
  it("matches a path named in a body, and hands back the line that names it", () => {
    const groups = lanes("app/src/plan.ts", [
      issue(1, "## Lane\n\n- `app/src/plan.ts` and its tests\n- nothing else"),
      issue(2, "touches `app/src/picks.ts` only"),
    ]);

    expect(groups).toEqual([
      {
        number: 1,
        title: "ticket 1",
        hits: [{ where: "body", line: "- `app/src/plan.ts` and its tests" }],
        children: [],
      },
    ]);
  });

  it("matches a path named only in a comment", () => {
    // #366's amendment, which names a folder: the folder itself, and a file in it, are both its lane
    const amended = issue(366, "split `server/src/api.ts`", [
      "Amendment: also `.claude/skills/orchestrate/`.",
    ]);
    expect(numbers(".claude/skills/orchestrate", [amended])).toEqual([366]);
    expect(numbers(".claude/skills/orchestrate/SKILL.md", [amended])).toEqual([366]);
    expect(numbers(".claude/skills/other.md", [amended])).toEqual([]);
    expect(
      lanes("server/src/api.ts", [issue(5, "nothing here", ["", "now `server/src/api.ts:120` too"])]),
    ).toEqual([
      {
        number: 5,
        title: "ticket 5",
        hits: [{ where: "comment 2", line: "now `server/src/api.ts:120` too" }],
        children: [],
      },
    ]);
  });

  it("matches a file under a directory argument", () => {
    expect(numbers("web/src/plan", [issue(7, "edits web/src/plan/PlanScreen.tsx")])).toEqual([7]);
    expect(numbers("web/src/plan/", [issue(7, "edits web/src/plan/PlanScreen.tsx")])).toEqual([7]);
  });

  it("does not match a path that is only a prefix of a different name", () => {
    expect(numbers("web/src/plan", [issue(8, "edits `web/src/planDiffs.ts`")])).toEqual([]);
    expect(numbers("app/src/plan.ts", [issue(8, "edits `app/src/plan.tsx`")])).toEqual([]);
  });

  it("matches the tail of a path written after its folder, as tickets do", () => {
    expect(numbers("app/src/plan.ts", [issue(376, "`app/src`: `edit.ts`, `plan.ts` and their tests")])).toEqual([376]);
    expect(numbers("app/src/plan.ts", [issue(9, "`app/src/planDiffSources.ts`")])).toEqual([]);
  });

  it("shows a matched sub-issue under its open parent, whether or not the parent matched", () => {
    const groups = lanes("app/src/edit.ts", [
      issue(376, "a composed parent naming no file"),
      issue(375, "`app/src/edit.ts:312` guards", [], 376),
      issue(374, "unrelated", [], 376),
      // a parent that is not open is not in the list, so its child stands alone
      issue(12, "`app/src/edit.ts`", [], 999),
    ]);

    expect(groups.map((g) => [g.number, g.hits.length, g.children.map((c) => c.number)])).toEqual([
      [12, 1, []],
      [376, 0, [375]],
    ]);
    expect(render([{ path: "app/src/edit.ts", groups }])).toContain(
      "    #375 ticket 375 (sub-issue of #376)",
    );
  });

  it("says so when no open issue names the path", () => {
    expect(render([{ path: "x/y.ts", groups: [] }])).toBe("x/y.ts\n  no open issue names it\n");
  });
});

describe("pathTokens and names", () => {
  it("reads paths out of markdown and leaves words alone", () => {
    expect(
      pathTokens("See [ADR-0005](docs/adr/0005-crawler.md), `CLAUDE.md` and ./tools/lanes/. Done."),
    ).toEqual(["docs/adr/0005-crawler.md", "CLAUDE.md", "tools/lanes"]);
  });

  it("compares literally, so a pattern character in a path is just a character", () => {
    expect(names("a.b", "a.b")).toBe(true);
    expect(names("axb", "a.b")).toBe(false);
  });
});
