import { expect, it } from "vitest";
import { parseArguments, rotatedNotice } from "./cli.ts";

const cwd = "/home/student/degree";

it("plans in the current directory when no Workspace is named", () => {
  expect(parseArguments([], cwd)).toEqual({
    kind: "launch",
    workspace: cwd,
    host: "127.0.0.1",
    open: true,
  });
});

it("resolves --workspace against the current directory", () => {
  const invocation = parseArguments(["--workspace", "../other"], cwd);

  // printed back to the student, so it has to be a path they can paste somewhere else
  expect(invocation).toMatchObject({ kind: "launch", workspace: "/home/student/other" });
});

it("keeps an absolute --workspace as it is", () => {
  expect(parseArguments(["--workspace", "/srv/plans"], cwd)).toMatchObject({
    workspace: "/srv/plans",
  });
});

it("prints the URL without opening a browser under --no-open", () => {
  expect(parseArguments(["--no-open"], cwd)).toMatchObject({ kind: "launch", open: false });
});

it.each([
  ["127.0.0.1", "127.0.0.1"],
  ["localhost", "localhost"],
  ["::1", "::1"],
  // a spelling of the same address, handed back as the one Node can resolve
  ["[::1]", "::1"],
  ["LOCALHOST", "localhost"],
])("binds %s, which is this machine and nobody else", (given, bound) => {
  expect(parseArguments(["--host", given], cwd)).toMatchObject({ kind: "launch", host: bound });
});

it.each([
  "0.0.0.0",
  "::",
  "192.168.1.20",
  "example.com",
  "127.0.0.1.evil.example",
  // loopback, but the guard refuses this name in a Host header and the printed URL
  // says localhost, so the student would get a server they cannot talk to
  "127.0.0.2",
  "::ffff:127.0.0.1",
])("refuses --host %s rather than serving a page that cannot reach the API", (host) => {
  const invocation = parseArguments(["--host", host], cwd);

  expect(invocation.kind).toBe("refusal");
  // the student is told what would make it work, not just that it did not
  expect(invocation).toMatchObject({ message: expect.stringContaining("password") });
});

it("refuses a flag it does not know rather than planning in the wrong folder", () => {
  const invocation = parseArguments(["--workspce", "/srv/plans"], cwd);

  expect(invocation).toMatchObject({
    kind: "refusal",
    message: expect.stringContaining("--workspce"),
  });
});

it.each(["--workspace", "--host"])("refuses %s with nothing after it", (flag) => {
  expect(parseArguments([flag], cwd)).toMatchObject({ kind: "refusal" });
  // the next flag is not the value: `--workspace --no-open` names no folder
  expect(parseArguments([flag, "--no-open"], cwd)).toMatchObject({ kind: "refusal" });
});

it("answers --help with the usage text and nothing else", () => {
  const invocation = parseArguments(["--help"], cwd);

  expect(invocation.kind).toBe("help");
  expect(invocation).toMatchObject({ text: expect.stringContaining("--workspace") });
});

/*
 * `rotate-token` — the first command this CLI has ever had (issue #99). Everything before
 * it was a flag on a launch, so the tests below are as much about the parser keeping the
 * two apart as about the command itself.
 */

it("reads rotate-token as the whole invocation, starting no server", () => {
  expect(parseArguments(["rotate-token"], cwd)).toEqual({ kind: "rotate-token" });
});

it.each(["--help", "-h"])("answers rotate-token %s with the usage text", (flag) => {
  const invocation = parseArguments(["rotate-token", flag], cwd);

  // where somebody who has just read the word rotate-token looks next
  expect(invocation).toMatchObject({ kind: "help" });
});

it.each([
  ["--workspace", "/srv/plans"],
  ["--host", "localhost"],
  ["--no-open"],
])("refuses rotate-token with %s, which would say nothing true about it", (...options) => {
  const invocation = parseArguments(["rotate-token", ...options], cwd);

  expect(invocation).toMatchObject({
    kind: "refusal",
    message: expect.stringContaining("rotate-token"),
  });
  // and says why: the token is not in a Workspace and nothing is being served
  expect(invocation).toMatchObject({ message: expect.stringContaining("config directory") });
});

it("tells the student rotate-token is a command when it arrives among the options", () => {
  const invocation = parseArguments(["--no-open", "rotate-token"], cwd);

  expect(invocation).toMatchObject({
    kind: "refusal",
    // "unknown option rotate-token" would be the one wrong thing to say about a word the
    // parser knows perfectly well
    message: expect.stringContaining("is a command, not an option"),
  });
});

it("still resolves a Workspace folder that happens to be called rotate-token", () => {
  // recognised as a command in the first position only, so this is a path and not a verb
  expect(parseArguments(["--workspace", "rotate-token"], cwd)).toMatchObject({
    kind: "launch",
    workspace: "/home/student/degree/rotate-token",
  });
});

it("puts rotate-token and where the token lives in --help, which is where people look", () => {
  const invocation = parseArguments(["--help"], cwd);

  expect(invocation).toMatchObject({ kind: "help" });
  const text = invocation.kind === "help" ? invocation.text : "";
  expect(text).toContain("rotate-token");
  // the manual remedy has to be findable too: a student who cannot run the command should
  // still learn which file to delete (issue #99, option 2 folded into option 1)
  expect(text).toContain(".config/biu-cs-planner/token");
  expect(text).toContain("APPDATA");
});

/**
 * The usage text is read *before* rotating, so it is where the harmful reading of "every
 * bookmark and every open tab stops working" happens: a student who does not stop the
 * running server has not finished rotating, and that server still honours the leaked
 * token. Pinned in both places because the first draft corrected `rotatedNotice` and left
 * this copy of the claim behind.
 */
it("does not promise in --help that rotating alone is enough", () => {
  const invocation = parseArguments(["--help"], cwd);
  const text = invocation.kind === "help" ? invocation.text : "";

  expect(text).toContain("Stop the app first");
  expect(text).toContain("until it exits");
});

it("warns in the rotation notice that bookmarks and open tabs have stopped working", () => {
  const notice = rotatedNotice({
    path: "/home/student/.config/biu-cs-planner/token",
    replaced: true,
  });

  expect(notice).toContain("/home/student/.config/biu-cs-planner/token");
  expect(notice).toContain("bookmark");
  expect(notice).toContain("tab");
  // describing what the page shows, never quoting it: that text is a translation, so an
  // English quotation would not match the screen a Hebrew reader sees
  expect(notice).not.toContain("has no launch token");
  // no URL: there is no port yet, and reprinting a secret into the scrollback that leaked
  // the last one would undo the rotation being reported
  expect(notice).not.toContain("http://");
});

/**
 * The one thing this notice must not do is say a student is safe while they are not. A
 * server that is up read the token at startup and holds it in memory, so the leaked token
 * still opens that process; only the restart finishes the rotation.
 */
it("tells the student to stop a server that is still running", () => {
  const notice = rotatedNotice({ path: "/tmp/config/token", replaced: true });

  expect(notice).toContain("Ctrl-C");
  expect(notice).toContain("until it exits");
  // and does not claim the refusal has already taken effect everywhere
  expect(notice).not.toContain("refused from now on");
});

it("does not claim a first token invalidated anything", () => {
  const notice = rotatedNotice({ path: "/tmp/config/token", replaced: false });

  expect(notice).toContain("There was none here before");
  expect(notice).not.toContain("bookmark");
});

it("cannot print the token even when handed one", () => {
  // a throwaway value shaped like a token; the real one is a live credential
  const rotation = {
    token: "this-is-not-a-real-token-only-shaped-like-one",
    path: "/tmp/config/token",
    replaced: true,
  };

  expect(rotatedNotice(rotation)).not.toContain(rotation.token);
});
