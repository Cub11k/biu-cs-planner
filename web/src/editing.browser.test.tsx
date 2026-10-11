/// <reference types="@vitest/browser-playwright" />
/**
 * The hook Plan and Progress read and edit through (#378), on a probe component over a fake read and
 * a fake edit, each answered when the test says so: which answer reaches the screen, what each kind of
 * edit answer does, and the spent-revision gate (#377). The screens' own tests cover the same through
 * the page; these pin the order of answers, which a page's fake `fetch` cannot hold still.
 */
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useEditing, type Editing } from "./editing.ts";

type Fake =
  | { kind: "served"; version: string }
  | { kind: "refused"; reason: string | undefined }
  | { kind: "unreadable-answer" }
  | { kind: "unauthorized" }
  | { kind: "unreachable" };

/** An answer the test hands over when it chooses. */
type Pending = { answer: (fake: Fake) => void };

let reads: Pending[];
let edited: number;
let latest: Editing<Fake> | undefined;
let host: HTMLElement | undefined;
let root: Root | undefined;

const load = (): Promise<Fake> =>
  new Promise((resolve) => {
    reads.push({ answer: resolve });
  });

function Probe({ changes }: { changes: number }): null {
  latest = useEditing(load, changes, () => {
    edited += 1;
  });
  return null;
}

const mount = (changes = 0): void => {
  root!.render(<Probe changes={changes} />);
};

beforeEach(() => {
  reads = [];
  edited = 0;
  latest = undefined;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  root?.unmount();
  host?.remove();
});

const served = (version: string): Fake => ({ kind: "served", version });

/** Waits for the probe's hook to hold what `check` asks of it. */
const until = (check: (editing: Editing<Fake>) => boolean): Promise<void> =>
  vi.waitFor(() => {
    if (latest === undefined || !check(latest)) throw new Error("not yet");
  });

const onScreen = (editing: Editing<Fake>): string =>
  editing.answer.kind === "served" ? (editing.answer as { version: string }).version : editing.answer.kind;

/** Mounts, and answers the first read with `v1`. */
async function servedV1(): Promise<void> {
  mount();
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  reads[0]!.answer(served("v1"));
  await until((editing) => onScreen(editing) === "v1");
}

/** Sends one edit and answers it with `fake`, returning what it was based on. */
async function edit(fake: Fake): Promise<{ basedOn: unknown; heard: Fake[] }> {
  let basedOn: unknown;
  const heard: Fake[] = [];
  const sent = latest!.send(
    (on) => {
      basedOn = on;
      return Promise.resolve(fake);
    },
    (answer) => heard.push(answer),
  );
  expect(sent).toBe(true);
  await vi.waitFor(() => expect(heard).toHaveLength(1));
  return { basedOn, heard };
}

it("drops a read's answer once a newer read or an edit's own answer is on screen", async () => {
  await servedV1();
  mount(1);
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  mount(2);
  await vi.waitFor(() => expect(reads).toHaveLength(3));

  reads[2]!.answer(served("v3"));
  await until((editing) => onScreen(editing) === "v3");
  reads[1]!.answer(served("v2"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(onScreen(latest!)).toBe("v3");

  // an edit's own answer is the newest: a read asked before it lands and is dropped
  mount(3);
  await vi.waitFor(() => expect(reads).toHaveLength(4));
  await edit(served("v9"));
  await until((editing) => onScreen(editing) === "v9");
  reads[3]!.answer(served("v4"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(onScreen(latest!)).toBe("v9");
});

it("takes a served edit answer on screen and tells the screen it edited, starting no re-read", async () => {
  await servedV1();
  const { basedOn, heard } = await edit(served("v2"));

  expect(basedOn).toBe("v1");
  expect(heard).toEqual([served("v2")]);
  await until((editing) => onScreen(editing) === "v2" && !editing.sending);
  expect(edited).toBe(1);
  expect(latest!.rereads).toBe(0);
  expect(latest!.spent).toBe(false);
  expect(reads).toHaveLength(1);
});

it.each([
  { fake: { kind: "refused", reason: "state-file-changed" } as Fake, mayHaveWritten: false },
  { fake: { kind: "refused", reason: "save-revision-unreadable" } as Fake, mayHaveWritten: true },
  { fake: { kind: "unreadable-answer" } as Fake, mayHaveWritten: true },
  // the request may have reached the server before the connection failed (#397)
  { fake: { kind: "unreachable" } as Fake, mayHaveWritten: true },
])("spends the revision on $fake.kind $fake.reason, sends nothing until the re-read is drawn", async ({ fake, mayHaveWritten }) => {
  await servedV1();
  const { heard } = await edit(fake);

  expect(heard).toEqual([fake]);
  await until((editing) => editing.spent && editing.rereads === 1);
  expect(edited).toBe(mayHaveWritten ? 1 : 0);
  // the gate: nothing is sent on the spent revision
  const refusedEdit = vi.fn(() => Promise.resolve(served("never")));
  expect(latest!.send(refusedEdit)).toBe(false);
  expect(refusedEdit).not.toHaveBeenCalled();

  await vi.waitFor(() => expect(reads).toHaveLength(2));
  reads[1]!.answer(served("v2"));
  await until((editing) => !editing.spent && onScreen(editing) === "v2");
  const { basedOn } = await edit(served("v3"));
  expect(basedOn).toBe("v2");
});

it.each([
  { kind: "refused", reason: "state-file-unreadable" } as Fake,
  { kind: "unreachable" } as Fake,
  { kind: "unreadable-answer" } as Fake,
])("releases the gate when the re-read answers $kind rather than serving", async (reread) => {
  await servedV1();
  await edit({ kind: "refused", reason: "state-file-changed" });
  await until((editing) => editing.spent);
  await vi.waitFor(() => expect(reads).toHaveLength(2));

  reads[1]!.answer(reread);

  await until((editing) => !editing.spent && editing.answer.kind === reread.kind);
});

it("drops a read already in flight when an answer spends the revision, so only the re-read releases", async () => {
  await servedV1();
  mount(1);
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  let refuse!: (fake: Fake) => void;
  expect(latest!.send(() => new Promise((resolve) => (refuse = resolve)))).toBe(true);
  await until((editing) => editing.sending);

  // asked before the file moved, and answering before the screen has even re-rendered: it is not
  // what the file says now
  refuse({ kind: "refused", reason: "state-file-changed" });
  reads[1]!.answer(served("v1-stale"));
  await until((editing) => editing.spent);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(latest!.spent).toBe(true);
  expect(onScreen(latest!)).toBe("v1");

  await vi.waitFor(() => expect(reads).toHaveLength(3));
  reads[2]!.answer(served("v2"));
  await until((editing) => !editing.spent && onScreen(editing) === "v2");
});

it.each([
  { kind: "refused", reason: "backup-refused" } as Fake,
  { kind: "refused", reason: undefined } as Fake,
  { kind: "unauthorized" } as Fake,
])("leaves the revision on screen live on $kind $reason, and only the screen hears it", async (fake) => {
  await servedV1();
  const { heard } = await edit(fake);

  expect(heard).toEqual([fake]);
  await until((editing) => !editing.sending);
  expect(latest!.spent).toBe(false);
  expect(latest!.rereads).toBe(0);
  expect(edited).toBe(0);
  expect(onScreen(latest!)).toBe("v1");
  const { basedOn } = await edit(served("v2"));
  expect(basedOn).toBe("v1");
});

it("sends nothing before anything is served, or while an edit is in flight", async () => {
  mount();
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  expect(latest!.send(() => Promise.resolve(served("x")))).toBe(false);
  reads[0]!.answer(served("v1"));
  await until((editing) => onScreen(editing) === "v1");

  let answer!: (fake: Fake) => void;
  expect(latest!.send(() => new Promise((resolve) => (answer = resolve)))).toBe(true);
  await until((editing) => editing.sending);
  expect(latest!.send(() => Promise.resolve(served("x")))).toBe(false);
  answer(served("v2"));
  await until((editing) => !editing.sending && onScreen(editing) === "v2");
});

it("sends one edit when two sends come in one batch, before the screen has re-rendered", async () => {
  await servedV1();
  const send = latest!.send;
  const first = vi.fn(() => new Promise<Fake>(() => {}));
  const second = vi.fn(() => Promise.resolve(served("x")));

  // both from one render, as two handlers in one React batch would call them
  expect(send(first)).toBe(true);
  expect(send(second)).toBe(false);

  expect(first).toHaveBeenCalledTimes(1);
  expect(second).not.toHaveBeenCalled();
});

it("keeps a fresh answer off screen when `keep` says so, and counts the answers kept", async () => {
  let keepIt = false;
  function Keeping({ changes }: { changes: number }): null {
    latest = useEditing(load, changes, () => {}, () => keepIt);
    return null;
  }
  root!.render(<Keeping changes={0} />);
  await vi.waitFor(() => expect(reads).toHaveLength(1));
  reads[0]!.answer(served("v1"));
  await until((editing) => onScreen(editing) === "v1");

  keepIt = true;
  root!.render(<Keeping changes={1} />);
  await vi.waitFor(() => expect(reads).toHaveLength(2));
  reads[1]!.answer(served("v2"));
  await until((editing) => editing.kept === 1);
  expect(onScreen(latest!)).toBe("v1");

  keepIt = false;
  root!.render(<Keeping changes={2} />);
  await vi.waitFor(() => expect(reads).toHaveLength(3));
  reads[2]!.answer(served("v3"));
  await until((editing) => editing.kept === 0 && onScreen(editing) === "v3");
});
