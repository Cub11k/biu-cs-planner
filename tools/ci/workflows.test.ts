import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  declaresPermissions,
  grantsEverything,
  installCommands,
} from "./workflows.ts";

const WORKFLOWS = fileURLToPath(new URL("../../.github/workflows/", import.meta.url));

const workflowFiles = (): string[] =>
  readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();

const read = (name: string): string => readFileSync(join(WORKFLOWS, name), "utf8");

describe("the workflows in this repository", () => {
  it("has some to check, so a passing suite is not an empty folder", () => {
    expect(workflowFiles().length).toBeGreaterThan(0);
  });

  it("installs with --ignore-scripts, everywhere, every time", () => {
    const installs = workflowFiles().flatMap((name) =>
      installCommands(name, read(name)),
    );

    // A workflow that installs nothing is fine; one that installs and has never been
    // seen to install is the case this guards against.
    expect(installs.length).toBeGreaterThan(0);

    const unguarded = installs
      .filter((command) => !command.ignoresScripts)
      .map((command) => `${command.file}:${command.line}: ${command.text}`);

    expect(unguarded).toEqual([]);
  });

  it("declares its own permissions rather than inheriting them", () => {
    const silent = workflowFiles().filter((name) => !declaresPermissions(read(name)));

    expect(silent).toEqual([]);
  });

  it("hands no job a write-all token", () => {
    const wide = workflowFiles().filter((name) => grantsEverything(read(name)));

    expect(wide).toEqual([]);
  });
});

describe("installCommands", () => {
  it("finds npm ci and npm install, with their line numbers", () => {
    const found = installCommands("w.yml", ["steps:", "  - run: npm ci"].join("\n"));

    expect(found).toEqual([
      { file: "w.yml", line: 2, text: "- run: npm ci", ignoresScripts: false },
    ]);
  });

  it("sees the flag when it is there", () => {
    const [found] = installCommands("w.yml", "- run: npm ci --ignore-scripts");

    expect(found?.ignoresScripts).toBe(true);
  });

  it("catches the short aliases a future author might reach for", () => {
    for (const command of ["npm i", "npm install -g npm@latest", "npm add zod"]) {
      expect(installCommands("w.yml", `  - run: ${command}`)).toHaveLength(1);
    }
  });

  it("is not fooled by a comment that talks about installing", () => {
    const found = installCommands(
      "w.yml",
      ["# what a student's `npm i -g` installs", "  # npm ci would go here"].join("\n"),
    );

    expect(found).toEqual([]);
  });

  it("leaves alone the npm commands that are not installs", () => {
    const found = installCommands(
      "w.yml",
      ["- run: npm run report", "- run: npm pack", "- run: npm publish"].join("\n"),
    );

    expect(found).toEqual([]);
  });

  it("reads an install split across lines as one command, at the line it starts on", () => {
    const found = installCommands(
      "w.yml",
      ["steps:", "  - run: |", "      npm ci \\", "        --ignore-scripts"].join("\n"),
    );

    expect(found).toEqual([
      { file: "w.yml", line: 3, text: "npm ci --ignore-scripts", ignoresScripts: true },
    ]);
  });

  it("still fails a split install that never reaches the flag", () => {
    const found = installCommands(
      "w.yml",
      ["      npm ci \\", "        --no-audit"].join("\n"),
    );

    expect(found).toEqual([
      { file: "w.yml", line: 1, text: "npm ci --no-audit", ignoresScripts: false },
    ]);
  });

  it("does not mistake a shell '#' for the start of a comment", () => {
    const found = installCommands("w.yml", '          token=${url##*#t=}; npm i "$TARBALL"');

    expect(found).toHaveLength(1);
  });
});

describe("the permissions helpers", () => {
  it("sees a top-level permissions block, and not a job-level one alone", () => {
    expect(declaresPermissions("permissions:\n  contents: read\n")).toBe(true);
    expect(declaresPermissions("jobs:\n  a:\n    permissions:\n      contents: read\n")).toBe(
      false,
    );
  });

  it("spots write-all, and ignores a comment warning against it", () => {
    expect(grantsEverything("permissions: write-all\n")).toBe(true);
    expect(grantsEverything("# never write-all\n")).toBe(false);
  });
});
