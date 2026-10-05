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
 * **The routes are read off the API's own route table, not listed here** (#332). PR #330 added the
 * Programs, Cohort and Progress routes after this test was written, and a list kept by hand did not
 * grow with them. So every route `createApi` registers is asked once honestly first, and whichever
 * answers a 200 with a `version` is a route that serves a revision — and the ones whose `version`
 * moved are the ones that save. Both lies are then put to exactly those routes. A route added
 * later is covered without editing this file, as long as the shared body below fits it; one it
 * does not fit answers 400 on the honest pass, and that fails here until it is given a body of its
 * own in `BODIES`.
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
const BLOCKED = `${TIMETABLE}/blocked-times`;
const VARIANTS = `${TIMETABLE}/variants`;
const PINS = "/api/progress/pins";
const TICKS = "/api/progress/ticks";
const UNDO = "/api/history/undo";
const BACKUPS = "/api/backups";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Which half of the port misreports, once it is told to. */
type Lying = "read" | "save";

/**
 * A real Workspace with an undo, a redo, a snapshot, a Catalog, a Blocked Time, a Pin, a tick and a
 * second Variant behind it, made honestly — and
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
  // Something for every route that removes or changes a thing to act on, so that each of them
  // saves on the honest pass: a Blocked Time to replace, remove or copy, a Pin and a tick to take
  // back, and a second Variant to make primary. Before the edit the undo below takes back.
  for (const [path, body] of [
    [BLOCKED, { day: "monday", start: "18:00", end: "20:00", label: "work" }],
    [PINS, { courseNumber: "89-110", requirementsFile: "cs-2027", requirementId: "electives" }],
    [TICKS, { requirementsFile: "cs-2027", requirementId: "hebrew" }],
    [VARIANTS, { name: "B" }],
  ] as const) {
    expect((await send("POST", path, { ...body, basedOn: await version() })).status).toBe(200);
  }
  // A route with a parameter `PARAMS` has no value for — `/api/plan/attempts/:id` — is about a
  // thing the collection route above it makes. That route is sent the shared body here, and the
  // id it answers with (`added`, or `id`) is the parameter's value, so the route is covered
  // without this file naming it.
  const ids: Record<string, string> = {};
  for (const { method, path } of api.routes) {
    const unknown = /^(.*)\/:(\w+)(\/|$)/.exec(path);
    if (method === "ALL" || unknown === null || unknown[2]! in PARAMS || unknown[2]! in ids) continue;
    const [, collection, name] = unknown;
    if (!api.routes.some((route) => route.method === "POST" && route.path === collection)) continue;
    const made = await send("POST", collection!, sharedBody(undefined, await version()));
    const body = (await made.json()) as { added?: unknown; id?: unknown };
    const id = body.added ?? body.id;
    if (typeof id === "string") ids[name!] = id;
  }
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
    api,
    ids,
    lie: (half: Lying, revision: () => unknown) => {
      lying = { half, revision };
    },
  };
}

type Staged = Awaited<ReturnType<typeof stage>>;

/** A route as the route table names it: `POST /api/timetable/:year/:semester/picks`. */
type Route = { method: string; path: string; key: string };

/** What a path parameter is filled with. A route with a parameter not here fails, naming it. */
const PARAMS: Record<string, string> = { year: "2027", semester: "fall", courseNumber: "89-110" };

/**
 * The one body every route that takes a body is sent, unless `BODIES` gives it its own: a field
 * for each thing a route in this API names, with values the staged Workspace makes into a real
 * edit. Routes parse their bodies with `z.object`, which drops a field it does not know, so one
 * body serves them all — a Pick route reads the Pick's fields and ignores the Blocked Time's.
 *
 * The values are chosen to **move** the file where they can: Group 02 over the staged 01, a name
 * no Variant has, the language the file does not hold. An edit that moves nothing saves nothing,
 * and a save the adapter never made is a save it cannot misreport.
 *
 * `academicYear`, `semester` and `status` are there for routes about an Attempt, which another
 * lane was adding in the run this was written in: a Course in a Semester with a status is what an
 * Attempt is (CONTEXT.md), so a route taking one should parse this body as it stands.
 */
const shared = ({ takenAt }: Staged, basedOn: string): Record<string, unknown> =>
  sharedBody(takenAt, basedOn);

function sharedBody(takenAt: number | undefined, basedOn: string): Record<string, unknown> {
  return {
  ...LECTURE,
  groupNumber: "02",
  variant: "A",
  name: "Z",
  day: "sunday",
  start: "08:00",
  end: "10:00",
  label: "commute",
  index: 0,
  toYear: 2027,
  toSemester: "spring",
  language: "he",
  requirementsFile: "cs-2027",
  requirementId: "core",
  programs: [{ requirementsFile: "cs-2027" }],
  cohort: { academicYear: 2026, semester: "fall" },
  file: {},
  takenAt,
  academicYear: 2027,
  semester: "fall",
  status: "planned",
  basedOn,
  };
}

/** The query every read is sent. A read ignores a parameter it does not take. */
const SHARED_QUERY = "semester=fall";

/** The routes `shared` does not fit, each with the body it takes. Keyed as `Route.key` is. */
const BODIES: Record<string, (staged: Staged, basedOn: string) => unknown> = {
  "POST /api/catalog/:year/import": () => CRAWL,
  // the Pin, the tick and the Variant `stage` made, so these three move the file too
  "DELETE /api/progress/pins": (staged, basedOn) => ({
    ...shared(staged, basedOn),
    requirementId: "electives",
  }),
  "DELETE /api/progress/ticks": (staged, basedOn) => ({
    ...shared(staged, basedOn),
    requirementId: "hebrew",
  }),
  "POST /api/timetable/:year/:semester/variants/primary": (staged, basedOn) => ({
    ...shared(staged, basedOn),
    variant: "B",
  }),
  // #295: Variant B holds nothing, so the Attempt of 89-110 the ids loop planned is a drop there
  "POST /api/timetable/:year/:semester/plan-diffs/apply": (staged, basedOn) => ({
    ...shared(staged, basedOn),
    variant: "B",
    kind: "drop",
  }),
  // #297: marking B registered moves both flags to it; the unmark takes the shared body's A, which
  // is not marked, so it saves nothing and only the read half reaches it. Only the mark: "apply
  // all" needs the digest of a preview (#355), and the flags alone are a save
  "POST /api/timetable/:year/:semester/variants/registered": (staged, basedOn) => ({
    ...shared(staged, basedOn),
    variant: "B",
    applyDiffs: false,
  }),
};

/** Every route `createApi` registers, once each: the route table, less its middleware. */
function routesOf(staged: Staged): Route[] {
  const seen = new Map<string, Route>();
  for (const { method, path } of staged.api.routes) {
    // `use` registers middleware under `ALL`; a route registered with `capped` before its handler
    // is listed once per handler, and is one route
    if (method === "ALL") continue;
    const key = `${method} ${path}`;
    if (!seen.has(key)) seen.set(key, { method, path, key });
  }
  return [...seen.values()];
}

/** Asks one route, with its parameters filled and, where it takes one, its body. */
async function ask(staged: Staged, route: Route, basedOn: string): Promise<Response> {
  const path = route.path.replace(/:(\w+)/g, (_, name: string) => {
    const value = PARAMS[name] ?? staged.ids[name];
    if (value === undefined) throw new Error(`${route.key}: no value for the parameter :${name}`);
    return value;
  });
  // the one query a read takes that is not optional: the Catalog's offerings name their Semester
  if (route.method === "GET") return staged.send("GET", `${path}?${SHARED_QUERY}`);
  const body = BODIES[route.key] ?? shared;
  return staged.send(route.method, path, body(staged, basedOn));
}

/** What the honest pass learned about one route. */
type Learned = Route & { serves: boolean; saves: boolean };

/**
 * Every route, asked once against an honest adapter in a Workspace of its own: whether it answers
 * a 200 with a `version`, which is what serving a revision is, and whether that `version` moved,
 * which is what saving is. A route the shared body does not fit answers 400 and fails here.
 */
async function learnRoutes(): Promise<Learned[]> {
  const learned: Learned[] = [];
  for (const route of routesOf(await stage())) {
    const staged = await stage();
    const before = await staged.version();
    const answer = await ask(staged, route, before);
    expect(answer.status, `${route.key} did not take the shared body: give it one in BODIES`).not.toBe(400);
    // a route that broke on the honest pass would otherwise count as serving no revision
    expect(answer.status, `${route.key} failed on an honest adapter`).toBeLessThan(500);
    const body: unknown = answer.status === 200 ? await answer.json() : undefined;
    const served =
      typeof body === "object" && body !== null && "version" in body ? body.version : undefined;
    if (served !== undefined) expect(isStateFileRevision(served), route.key).toBe(true);
    learned.push({ ...route, serves: served !== undefined, saves: served !== undefined && served !== before });
  }
  return learned;
}

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

/**
 * What the two lies are put to, learned once for both: every route that serves a revision, and of
 * those, every one that saves. Asserted to include the routes the ticket names, so a derivation
 * that went wrong cannot pass by covering nothing.
 */
let learned: Promise<Learned[]> | undefined;
const routesServing = async (): Promise<Learned[]> => {
  learned ??= learnRoutes();
  const routes = await learned;
  const serving = routes.filter((route) => route.serves).map((route) => route.key);
  for (const named of [
    "GET /api/timetable/:year/:semester",
    "GET /api/programs",
    "PUT /api/programs",
    "PUT /api/cohort",
    "GET /api/progress",
    "POST /api/progress/pins",
    "POST /api/progress/ticks",
  ]) {
    expect(serving, `the honest pass should find ${named} serving a revision`).toContain(named);
  }
  // and the ones that write, saving: a shared body that stopped moving one would drop it from
  // the save half without a word
  const saving = routes.filter((route) => route.saves).map((route) => route.key);
  for (const named of [
    "PUT /api/programs",
    "PUT /api/cohort",
    "POST /api/progress/pins",
    "POST /api/progress/ticks",
    "POST /api/timetable/:year/:semester/plan-diffs/apply",
    "POST /api/timetable/:year/:semester/variants/registered",
  ]) {
    expect(saving, `the honest pass should find ${named} saving`).toContain(named);
  }
  return routes;
};

for (const half of ["read", "save"] as const) {
  it(`serves no revision a hostile adapter made up on a ${half}, on any route`, async () => {
    const routes = (await routesServing()).filter((route) =>
      half === "read" ? route.serves : route.saves,
    );
    for (const route of routes) {
      for (const [kind, make] of REVISIONS) {
        const staged = await stage();
        const honest = await staged.version();
        const revision = await make(staged, honest);
        staged.lie(half, () => revision);

        const answer = await ask(staged, route, honest);
        const where = `${route.key}, ${kind}, on the ${half}`;
        // refused, and refused as this: a route answering for some other reason, or not reaching
        // the port at all, would prove nothing about the revision
        expect(answer.status, where).toBe(409);
        const body = await answer.text();
        // A lie on the read refuses before anything is written. One on the save comes after the
        // write, so its reason says the save may have landed rather than that nothing changed (#326).
        expect(JSON.parse(body), where).toMatchObject({
          reason: half === "read" ? "workspace-refused" : "save-revision-unreadable",
        });
        expect(body, where).not.toContain('"version"');
        const spelled = typeof revision === "string" ? revision : JSON.stringify(revision);
        expect(body, where).not.toContain(JSON.stringify(spelled).slice(1, -1));
        expect(body, where).not.toContain(staged.root);
      }
    }
    // A budget rather than the default five seconds, as `tools/pr-review/followers.test.ts` gives
    // its whole-tree tests and for the same reason: this stages a fresh Workspace — a create, an
    // import, two Picks, four other edits and an undo, each a real disk write — for every route and
    // every revision, and the routes are every one the API has (#332). The first of the two tests
    // also runs the honest pass, one more Workspace per route. Measured on PR #300's branch with
    // nine routes listed by hand: 2882ms alone, 3823–5330ms inside `npm test`.
  }, 120_000);
}
