import { describe, expect, it } from "vitest";
import { usable, type Finding } from "./review.ts";

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
