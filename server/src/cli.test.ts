import { expect, it } from "vitest";
import { parseArguments } from "./cli.ts";

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
