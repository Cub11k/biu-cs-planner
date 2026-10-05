import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { isStateFileRevision, type Workspace } from "@biu-cs-planner/app";
import { createApi } from "./api.ts";
import { fileSystemWorkspace } from "./workspace.fs.ts";

/**
 * #311: **an adapter cannot get a revision of its own choosing into any API response.**
 *
 * #249 (PR #280) made that true of a refusal's sentence and left the other adapter-produced string
 * that travels to the page: the State File's revision, which `StateFileVersion` types as a plain
 * `string` and nine routes serve as `version`. This is that PR's hostile-adapter test, for the
 * revision. A Proxy over the real adapter answers every call honestly but misreports the revision —
 * on the read in the first pass, on the save in the second — and every route that serves one is
 * asked. None may answer with it, and each must be refused rather than serve something else, so a
 * route that stopped reaching the port fails here rather than passing by accident.
 *
 * Its own file rather than a test in `./api.test.ts`, which another lane holds in the run this was
 * written in; it builds the API the same way that file does.
 *
 * **A fresh Workspace per route and per revision.** A misreported save still lands — what `app`
 * refuses is passing the adapter's account of it on (`editStateFile` in `app/src/edit.ts` says
 * why) — so after one the undo stack no longer knows the file, and the next undo would be refused
 * as `history-invalidated` for a reason that is not this one. Staging each case from scratch keeps
 * every refusal below the one under test.
 */

const TOKEN = "test-launch-token-long-enough-to-look-like-a-real-one";
const bearer = { Authorization: `Bearer ${TOKEN}` };

/** Fixture data is invented; 89-110 and 89-210 are real BIU course numbers, nothing else is. */
const CRAWL = {
  rows: [
    {
      code: "89110",
      name: "מבוא למדעי המחשב",
      group: "01",
      teachers: "פרופ' נועה אגמון",
      kind: "הרצאה",
      semester: "סמסטר א'",
      day: "ג'",
      hours: "15:00 - 18:00",
      lid: "808655",
    },
  ],
  details: {},
};
const LECTURE = {
  courseNumber: "89-110",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "15:00", end: "18:00" }],
};
const CLASHING = {
  courseNumber: "89-210",
  lessonType: "הרצאה",
  groupNumber: "01",
  meetings: [{ semester: "fall", day: "tuesday", start: "16:00", end: "17:00" }],
};

const TIMETABLE = "/api/timetable/2027/fall";
const PICKS = `${TIMETABLE}/picks`;
const EXAMS = `${TIMETABLE}/exams`;
const SETTINGS = "/api/settings";
const UNDO = "/api/history/undo";
const REDO = "/api/history/redo";
const BACKUPS = "/api/backups";
const RESTORE = "/api/backups/restore";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Which half of the port misreports, once it is told to. */
type Lying = "read" | "save";

/**
 * A real Workspace with an undo, a redo, a snapshot and a Catalog behind it, made honestly — and
 * then a switch that makes the adapter misreport the revision from then on.
 */
async function stage() {
  const root = await mkdtemp(join(tmpdir(), "biu-revision-"));
  roots.push(root);
  const real = fileSystemWorkspace(root);
  let lying: { half: Lying; revision: () => unknown } | undefined;

  // **A Proxy over every method, telling the two answers it rewrites apart by their shape**, as
  // `./api.test.ts`'s hostile test is a Proxy over every method: a State File read is the one
  // answer that carries a `version`, and a save is the one that is a string. So the double names
  // no method of the port, and it is a decorator and never a writer — every save still reaches the
  // real adapter through `editStateFile`, as production's do, which is also why
  // `tools/ci/state-file-writer.ts` has nothing to find here. Only the revision is replaced.
  const hostile: Workspace = new Proxy(real, {
    get(target, property, receiver) {
      const method: unknown = Reflect.get(target, property, receiver);
      if (typeof method !== "function" || property === "watch") return method;
      return async (...args: unknown[]): Promise<unknown> => {
        const answer: unknown = await (method as (...args: unknown[]) => unknown).apply(
          target,
          args,
        );
        if (lying?.half === "read" && typeof answer === "object" && answer !== null) {
          if ("version" in answer) return { ...answer, version: lying.revision() };
        }
        if (lying?.half === "save" && typeof answer === "string") return lying.revision();
        return answer;
      };
    },
  });
  const api = createApi({ workspace: hostile, token: TOKEN, changes: { changeCount: () => 0 } });

  const send = async (method: string, path: string, body?: unknown): Promise<Response> =>
    await api.request(path, {
      method,
      headers:
        body === undefined ? bearer : { "Content-Type": "application/json", ...bearer },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const version = async (): Promise<string> => {
    const served = ((await (await send("GET", TIMETABLE)).json()) as { version: string }).version;
    // the honest half of the double, asserted rather than assumed
    expect(isStateFileRevision(served)).toBe(true);
    return served;
  };

  expect((await send("POST", "/api/workspace", {})).status).toBe(200);
  expect((await send("POST", "/api/catalog/2027/import", CRAWL)).status).toBe(200);
  expect((await send("POST", PICKS, { ...LECTURE, basedOn: undefined })).status).toBe(200);
  expect((await send("POST", PICKS, { ...CLASHING, basedOn: await version() })).status).toBe(200);
  // one undo, so both stacks hold an entry and a redo has something to put back
  expect((await send("POST", UNDO, { basedOn: await version() })).status).toBe(200);
  const listed = (await (await send("GET", BACKUPS)).json()) as {
    snapshots: { takenAt: number }[];
  };
  const takenAt = listed.snapshots[0]?.takenAt;
  expect(takenAt).toBeDefined();

  return {
    root,
    send,
    version,
    takenAt,
    lie: (half: Lying, revision: () => unknown) => {
      lying = { half, revision };
    },
  };
}

type Staged = Awaited<ReturnType<typeof stage>>;

/** Every route that serves a revision, and the request that asks it for one. */
const ROUTES: [string, (staged: Staged, basedOn: string) => Promise<Response>][] = [
  ["GET week", ({ send }) => send("GET", TIMETABLE)],
  ["GET exams", ({ send }) => send("GET", EXAMS)],
  ["GET settings", ({ send }) => send("GET", SETTINGS)],
  ["POST pick", ({ send }, basedOn) => send("POST", PICKS, { ...LECTURE, groupNumber: "02", basedOn })],
  [
    "DELETE pick",
    ({ send }, basedOn) =>
      send("DELETE", PICKS, { courseNumber: "89-110", lessonType: "הרצאה", basedOn }),
  ],
  // not the language the file holds, which would be no edit and so no save to misreport
  ["PATCH settings", ({ send }, basedOn) => send("PATCH", SETTINGS, { language: "he", basedOn })],
  ["POST undo", ({ send }, basedOn) => send("POST", UNDO, { basedOn })],
  ["POST redo", ({ send }, basedOn) => send("POST", REDO, { basedOn })],
  [
    "POST restore",
    ({ send, takenAt }, basedOn) => send("POST", RESTORE, { takenAt, basedOn }),
  ],
];

/** The routes that save, which are the ones a misreported save can reach. */
const SAVES = new Set(["POST pick", "DELETE pick", "PATCH settings", "POST undo", "POST redo", "POST restore"]);

/**
 * The revisions a careless or hostile adapter could hand back: the file's own content, a path to
 * it, the real revision spelled in upper case (a format drift, not a lie about the content), the
 * real one with a newline after it, and something that is not a string at all. Each is a
 * function of the staged Workspace, so the content and the path are this Workspace's own.
 */
const REVISIONS: [string, (staged: Staged, honest: string) => Promise<unknown>][] = [
  ["the file's content", async ({ root }) => readFile(join(root, "me.state.json"), "utf8")],
  ["a path", async ({ root }) => join(await realpath(root), "me.state.json")],
  ["upper case", async (_, honest) => honest.toUpperCase()],
  ["a trailing newline", async (_, honest) => `${honest}\n`],
  ["not a string", async ({ root }) => ({ path: root })],
];

for (const half of ["read", "save"] as const) {
  it(`serves no revision a hostile adapter made up on a ${half}, on any route`, async () => {
    for (const [route, ask] of ROUTES) {
      if (half === "save" && !SAVES.has(route)) continue;
      for (const [kind, make] of REVISIONS) {
        const staged = await stage();
        const honest = await staged.version();
        const revision = await make(staged, honest);
        staged.lie(half, () => revision);

        const answer = await ask(staged, honest);
        const where = `${route}, ${kind}, on the ${half}`;
        // refused, and refused as this: a route answering for some other reason, or not reaching
        // the port at all, would prove nothing about the revision
        expect(answer.status, where).toBe(409);
        const body = await answer.text();
        expect(JSON.parse(body), where).toMatchObject({ reason: "workspace-refused" });
        expect(body, where).not.toContain('"version"');
        const spelled = typeof revision === "string" ? revision : JSON.stringify(revision);
        expect(body, where).not.toContain(JSON.stringify(spelled).slice(1, -1));
        expect(body, where).not.toContain(staged.root);
      }
    }
  });
}
