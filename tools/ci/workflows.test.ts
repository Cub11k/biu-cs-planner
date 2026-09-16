import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  declaresPermissions,
  grantsWriteAll,
  writeScopes,
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
    const wide = workflowFiles().filter((name) => grantsWriteAll(read(name)));

    expect(wide).toEqual([]);
  });

  // Not "no broader than what it does" -- no test can read a workflow's mind. This is
  // the mechanical half: the write scopes this repository has a reason for are listed
  // here, so a workflow reaching for a new one has to come through this line and say
  // why. Every other scope any workflow holds is read.
  it("grants write only where this repository has a reason for it", () => {
    // pull-requests: pr-report.yml and pr-review.yml each edit one sticky comment.
    // id-token: release.yml's publish job proves who it is to npm, which is what
    // replaces an npm token sitting in a secret.
    const allowed = ["pull-requests", "id-token"];

    const unexpected = workflowFiles().flatMap((name) =>
      writeScopes(read(name))
        .filter((scope) => !allowed.includes(scope))
        .map((scope) => `${name}: ${scope}`),
    );

    expect(unexpected).toEqual([]);
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

  it("judges each command in a chain on its own", () => {
    const found = installCommands(
      "w.yml",
      "      - run: npm ci --ignore-scripts && npm install some-package",
    );

    expect(found).toHaveLength(2);
    expect(found.map((command) => command.ignoresScripts)).toEqual([true, false]);
  });

  it("splits on the other separators a shell line can hold", () => {
    for (const separator of [";", "&&", "||", "|", "&"]) {
      const found = installCommands("w.yml", `npm ci --ignore-scripts ${separator} npm i evil`);

      expect(found.map((command) => command.ignoresScripts)).toEqual([true, false]);
    }
  });

  it("sees the subcommand past npm's own options", () => {
    for (const command of [
      "npm --prefix web install evil",
      "npm --silent ci",
      "npm -w core install evil",
    ]) {
      expect(installCommands("w.yml", command)).toHaveLength(1);
    }
  });

  it("does not call npm run an install, however it is spelled", () => {
    for (const command of [
      "npm run install-fixtures",
      "npm --silent run report",
      "npm exec -- install",
    ]) {
      expect(installCommands("w.yml", command)).toEqual([]);
    }
  });

  it("does not let a trailing comment lend a command the flag", () => {
    const [found] = installCommands("w.yml", "      - run: npm ci  # --ignore-scripts goes here");

    expect(found?.ignoresScripts).toBe(false);
  });

  it("does not read an install out of a trailing comment either", () => {
    expect(installCommands("w.yml", "      - run: echo hi  # npm ci")).toEqual([]);
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
    expect(grantsWriteAll("permissions: write-all\n")).toBe(true);
    expect(grantsWriteAll("# never write-all\n")).toBe(false);
  });

  it("names the scopes granted at write, and no others", () => {
    const yaml = [
      "permissions:",
      "  contents: read",
      "  pull-requests: write",
      "jobs:",
      "  publish:",
      "    permissions:",
      "      id-token: write",
    ].join("\n");

    expect(writeScopes(yaml)).toEqual(["pull-requests", "id-token"]);
  });
});
