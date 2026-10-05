import { describe, expect, it } from "vitest";
import type { PullRequest } from "./github.ts";
import { closingSection, usable, type Finding } from "./review.ts";

const finding = (over: Partial<Finding> = {}): Finding => ({
  file: "core/src/plan.ts",
  line: 42,
  severity: "medium",
  defect: "The credit total counts an exempt Attempt.",
  scenario: "A Plan with one exempt Attempt reports 3 credits more than it has.",
  ...over,
});

describe("usable", () => {
  it("keeps a finding that carries a file, a line, a defect and a scenario", () => {
    expect(usable([finding()])).toHaveLength(1);
  });

  it("drops a finding with no failure scenario, because that is a hunch", () => {
    expect(usable([finding({ scenario: "   " })])).toEqual([]);
  });

  it("drops a finding that does not say what is wrong", () => {
    expect(usable([finding({ defect: "" })])).toEqual([]);
  });

  it("drops a finding that points at no file", () => {
    expect(usable([finding({ file: "" })])).toEqual([]);
  });

  it("drops a finding with no real line, so the reader is never sent to line 0", () => {
    expect(usable([finding({ line: 0 })])).toEqual([]);
  });

  it("keeps the order it was given, so ranking stays the renderer's job", () => {
    const kept = usable([
      finding({ file: "a.ts" }),
      finding({ file: "b.ts", scenario: "" }),
      finding({ file: "c.ts" }),
    ]);
    expect(kept.map((f) => f.file)).toEqual(["a.ts", "c.ts"]);
  });
});

describe("closingSection", () => {
  const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
    number: 1,
    title: "t",
    body: "b",
    headSha: "h",
    baseSha: "b",
    isFork: false,
    closes: [{ number: 6, title: "the sixth", body: "- [ ] it works" }],
    ...over,
  });

  it("hands the Spec pass every issue it was given, and no caveat when nothing was cut", () => {
    const text = closingSection(pr());
    expect(text).toContain("the sixth");
    expect(text).not.toContain("were not read");
  });

  it("tells the Spec pass the list stops short when it was cut", () => {
    expect(closingSection(pr({ closesCutAt: 1 }))).toContain(
      "These are the first 1 of the issues this pull request closes; GitHub lists more",
    );
  });

  it("says there are no criteria when nothing is closed", () => {
    expect(closingSection(pr({ closes: [] }))).toContain("closes no issue");
  });
});
