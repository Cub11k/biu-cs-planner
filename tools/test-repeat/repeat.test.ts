import { describe, expect, it } from "vitest";
import { parseArgs, repeat, screenshotsIn, type Attempt } from "./repeat.ts";

describe("parseArgs", () => {
  it("takes the file, a count and the load flag in any order", () => {
    expect(parseArgs(["--load", "a.test.ts", "--times", "50"])).toEqual({ file: "a.test.ts", times: 50, load: true });
  });

  it("runs twenty times without load unless told", () => {
    expect(parseArgs(["a.test.ts"])).toEqual({ file: "a.test.ts", times: 20, load: false });
  });

  it("refuses a missing file, a bad count and a second file", () => {
    expect(() => parseArgs([])).toThrow("usage");
    expect(() => parseArgs(["a.test.ts", "--times", "0"])).toThrow("--times");
    expect(() => parseArgs(["a.test.ts", "b.test.ts"])).toThrow("unexpected");
  });
});

describe("repeat", () => {
  const passing: Attempt = { passed: true, output: "ok", failed: [] };
  const failing = (index: number): Attempt => ({ passed: false, output: `run ${index}`, failed: ["a > it races"] });

  it("counts every run exactly and keeps only the first failure's output", async () => {
    const kept: string[] = [];
    const tally = await repeat(
      5,
      async (index) => (index === 2 || index === 4 ? failing(index) : passing),
      async (attempt, index) => {
        kept.push(`${index}: ${attempt.output}`);
      },
    );
    expect(tally).toEqual({ passed: 3, failed: 2, failures: { "a > it races": 2 } });
    expect(kept).toEqual(["2: run 2"]);
  });
});

describe("screenshotsIn", () => {
  it("finds the failure screenshots the reporter names, and nothing else", () => {
    const output = [
      " FAIL  web/a.browser.test.tsx > races",
      "AssertionError: expected 1 to be 2",
      "  - .vitest/attachments/failure-screenshots/a.browser.test.tsx/races.png",
      "- Expected",
    ].join("\n");
    expect(screenshotsIn(output)).toEqual([".vitest/attachments/failure-screenshots/a.browser.test.tsx/races.png"]);
  });
});
