/**
 * Asking the API for Progress, and sending the Progress screen's edits (#288): a Pin, an unpin, a
 * tick and an untick, the student's Programs (#331) and their Cohort.
 *
 * Beside the screen rather than inside it, as `../timetable/picks.ts` is, so every answer the API
 * can give is testable against a fake fetch. The shapes are read off the contract and never
 * redeclared here: `web` reaches the domain through the typed client alone (CLAUDE.md).
 */
import type { InferRequestType, InferResponseType } from "hono/client";
import { askApi, askFor, type AnswerReaders } from "../body.ts";
import type { ApiClient } from "../changes.ts";

type ProgressRoutes = ApiClient["api"]["progress"];
type ReadRoute = ProgressRoutes["$get"];
type PinRoute = ProgressRoutes["pins"]["$post"];
type UnpinRoute = ProgressRoutes["pins"]["$delete"];
type TickRoute = ProgressRoutes["ticks"]["$post"];
type UntickRoute = ProgressRoutes["ticks"]["$delete"];
type ProgramsRoute = ApiClient["api"]["programs"]["$put"];
type CohortRoute = ApiClient["api"]["cohort"]["$put"];
type RequirementsRoute = ApiClient["api"]["requirements"]["$get"];

type Answer = InferResponseType<ReadRoute>;
type ServedProgress = Extract<Answer, { programs: unknown }>;
/** An edit that landed and whose Progress could not be built (#395): every edit route can answer it. */
type NoViewed = Extract<InferResponseType<PinRoute>, { noView: true }>;

/** One chosen Program, evaluated or not, as the API serves it. */
export type ProgramProgress = ServedProgress["programs"][number];
export type EvaluatedProgram = Extract<ProgramProgress, { status: "evaluated" }>;
/** One node of a Program's Requirement tree, in both lenses. */
export type EvaluatedRequirement = EvaluatedProgram["progress"]["requirements"][number];
export type SolverWarning = ServedProgress["solverWarnings"][number];
export type ProgramsWarning = ServedProgress["programWarnings"][number];
export type PinWarning = ServedProgress["pinWarnings"][number];
export type EngineWarning = EvaluatedProgram["progress"]["warnings"][number];
/** What reading the State File raised: an entry left out, a Cohort that could not be read. */
export type StateWarning = ServedProgress["warnings"][number];

/** Why the API would not serve or edit Progress: the State File's refusals. */
export type ProgressRefusal = Extract<Answer, { reason: unknown }>["reason"];

/** The Academic Year and Semester the student started in, or `null` when none is chosen. */
export type Cohort = ServedProgress["cohort"];

/** The revision Progress was read from, and what a Pin or a tick is based on. */
export type ProgressVersion = ServedProgress["version"];

export type ProgressResult =
  | {
      kind: "served";
      cohort: Cohort;
      programs: ProgramProgress[];
      stoppedEarly: boolean;
      solverWarnings: SolverWarning[];
      programWarnings: ProgramsWarning[];
      pinWarnings: PinWarning[];
      stateWarnings: StateWarning[];
      version: ProgressVersion;
    }
  | { kind: "refused"; reason: ProgressRefusal | undefined }
  /** The edit was saved at `version` and no Progress came with it, so the screen reads it again (#414). */
  | NoViewProgress
  /** This page has no launch token, so the server will not talk to it (ADR-0004). */
  | { kind: "unauthorized" }
  /** An answer arrived whose body this page cannot read; nothing is known about the file. */
  | { kind: "unreadable-answer" }
  /** The request never arrived. */
  | { kind: "unreachable" };

type NoViewProgress = { kind: "no-view"; version: NoViewed["version"]; stateWarnings: NoViewed["warnings"] };
const noView = (body: NoViewed): NoViewProgress => ({
  kind: "no-view",
  version: body.version,
  stateWarnings: body.warnings ?? [],
});

/** Every Progress answer read the same way: its refusal's `reason`, and served Progress. */
const progress: AnswerReaders<ProgressResult, { reason?: ProgressRefusal }, ServedProgress, NoViewed> = {
  refused: (body) => ({ kind: "refused", reason: body.reason }),
  served: (body) =>
    // the screen loops over the Programs, and an answer without them is not Progress (#382)
    Array.isArray(body.programs)
      ? {
          kind: "served",
          cohort: body.cohort ?? null,
          programs: body.programs,
          stoppedEarly: body.stoppedEarly,
          solverWarnings: body.solverWarnings ?? [],
          programWarnings: body.programWarnings ?? [],
          pinWarnings: body.pinWarnings ?? [],
          stateWarnings: body.warnings ?? [],
          version: body.version,
        }
      : undefined,
  noView,
};

const ask = (send: () => Promise<Response>): Promise<ProgressResult> => askApi(send, progress);

/**
 * Progress for the student's chosen Programs, recomputed by the server now — or, given `whatIf`,
 * for those Programs in their place (#289): the same read, evaluated and never saved, whose
 * `version` is still the file's and so what adopting the what-if is based on.
 */
export function fetchProgress(client: ApiClient, whatIf?: ProgramChoice[]): Promise<ProgressResult> {
  if (whatIf === undefined) return ask(() => client.api.progress.$get());
  // the route reads `whatIf` itself (`server/src/api.ts`, `whatIfOf`), so the contract types no query
  const request = { query: { whatIf: JSON.stringify(whatIf) } } as unknown as InferRequestType<ReadRoute>;
  return ask(() => client.api.progress.$get(request));
}

/** A Course and the Requirement of one Requirements File it is pinned to. */
export type PinRequest = { courseNumber: string; requirementsFile: string; requirementId: string };

/** A Manual Requirement of one Requirements File. */
export type TickRequest = { requirementsFile: string; requirementId: string };

/** Pins a Course, on the revision the view was read from. */
export function pinCourse(
  client: ApiClient,
  pin: PinRequest,
  basedOn: ProgressVersion,
): Promise<ProgressResult> {
  const request = { json: { ...pin, basedOn } } as InferRequestType<PinRoute>;
  return ask(() => client.api.progress.pins.$post(request));
}

export function unpinCourse(
  client: ApiClient,
  pin: PinRequest,
  basedOn: ProgressVersion,
): Promise<ProgressResult> {
  const request = { json: { ...pin, basedOn } } as InferRequestType<UnpinRoute>;
  return ask(() => client.api.progress.pins.$delete(request));
}

export function tickManual(
  client: ApiClient,
  tick: TickRequest,
  basedOn: ProgressVersion,
): Promise<ProgressResult> {
  const request = { json: { ...tick, basedOn } } as InferRequestType<TickRoute>;
  return ask(() => client.api.progress.ticks.$post(request));
}

export function untickManual(
  client: ApiClient,
  tick: TickRequest,
  basedOn: ProgressVersion,
): Promise<ProgressResult> {
  const request = { json: { ...tick, basedOn } } as InferRequestType<UntickRoute>;
  return ask(() => client.api.progress.ticks.$delete(request));
}

/** One file in `requirements/`, as the Program chooser lists it. */
export type ListedRequirements = Extract<
  InferResponseType<RequirementsRoute>,
  { files: unknown }
>["files"][number];

/** The Requirements Files to choose a Program from, or `undefined` when they could not be had. */
export function fetchRequirementsFiles(client: ApiClient): Promise<ListedRequirements[] | undefined> {
  return askFor(
    () => client.api.requirements.$get(),
    // the chooser loops over the files (#382)
    (body: Extract<InferResponseType<RequirementsRoute>, { files: unknown }>) =>
      Array.isArray(body.files) ? body.files : undefined,
  );
}

/** What choosing the Programs came to: saved, or why not. */
export type ProgramsChoice =
  | { kind: "saved" }
  | NoViewProgress
  | { kind: "refused"; reason: ProgressRefusal | undefined }
  | { kind: "unauthorized" }
  | { kind: "unreadable-answer" }
  | { kind: "unreachable" };

/**
 * A save whose answer is not Progress: saved, or why not. Progress is read again after it, so the
 * served body is read for being readable and nothing else.
 */
const saved = (send: () => Promise<Response>): Promise<ProgramsChoice> =>
  askApi(send, {
    refused: (body: { reason?: ProgressRefusal }): ProgramsChoice => ({ kind: "refused", reason: body.reason }),
    served: (): ProgramsChoice => ({ kind: "saved" }),
    noView,
  });

/** One Program as the student chooses it: a Requirements File by name, and maybe a Track of it. */
export type ProgramChoice = { requirementsFile: string; track?: string };

/** Chooses the student's Programs, the whole list, on the revision the view was read from. */
export function choosePrograms(
  client: ApiClient,
  programs: ProgramChoice[],
  basedOn: ProgressVersion,
): Promise<ProgramsChoice> {
  const request = { json: { programs, basedOn } } as InferRequestType<ProgramsRoute>;
  return saved(() => client.api.programs.$put(request));
}

/** Sets the student's Cohort, or clears it with `null`, on the revision the view was read from. */
export function chooseCohort(
  client: ApiClient,
  cohort: Cohort,
  basedOn: ProgressVersion,
): Promise<ProgramsChoice> {
  const request = { json: { cohort, basedOn } } as InferRequestType<CohortRoute>;
  return saved(() => client.api.cohort.$put(request));
}

/** Which lens a node's status is read in: what is completed, or what the Plan would complete. */
export type Lens = "completed" | "projected";

/**
 * What a what-if would change in one Program (#289), by Requirement id: the Requirements that would
 * become satisfied, the ones that would become missing — satisfied now and not under the what-if,
 * or a Requirement only the what-if has, such as another Track's, that it would leave to do — and
 * the ones it would no longer have at all. Each in the order its tree lists them.
 */
export type WhatIfChanges = { satisfied: string[]; missing: string[]; dropped: string[] };

/** Every node of a tree by id, in tree order, with its status in one lens. */
function statuses(nodes: readonly EvaluatedRequirement[], lens: Lens, into = new Map<string, string>()) {
  for (const node of nodes) {
    into.set(node.id, node[lens].status);
    statuses(node.children, lens, into);
  }
  return into;
}

/**
 * Pairs two evaluations of one Requirements File by Requirement id, never by position: an id is
 * unique within one file (`GLOSSARY.md`, Pin), so it is the same Requirement in both trees, and the
 * base rule set they share pairs up while each Track's own Requirements are what one side has and
 * the other lacks. Only meaningful for one file — two files' ids name unrelated Requirements, and
 * the caller compares nothing across them.
 */
export function whatIfChanges(real: EvaluatedProgram, whatIf: EvaluatedProgram, lens: Lens): WhatIfChanges {
  const now = statuses(real.progress.requirements, lens);
  const then = statuses(whatIf.progress.requirements, lens);
  const changes: WhatIfChanges = { satisfied: [], missing: [], dropped: [] };
  for (const [id, status] of then) {
    const held = now.get(id);
    if (status === "satisfied" && held !== undefined && held !== "satisfied") changes.satisfied.push(id);
    else if (status !== "satisfied" && (held === undefined || held === "satisfied")) changes.missing.push(id);
  }
  for (const id of now.keys()) if (!then.has(id)) changes.dropped.push(id);
  return changes;
}
