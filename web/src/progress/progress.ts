/**
 * Asking the API for Progress, and sending the Progress screen's edits (#288): a Pin, an unpin, a
 * tick and an untick, and the Program choice the screen offers when none is chosen.
 *
 * Beside the screen rather than inside it, as `../timetable/picks.ts` is, so every answer the API
 * can give is testable against a fake fetch. The shapes are read off the contract and never
 * redeclared here: `web` reaches the domain through the typed client alone (CLAUDE.md).
 */
import type { InferRequestType, InferResponseType } from "hono/client";
import { readBody, UNAUTHORIZED } from "../body.ts";
import type { ApiClient } from "../changes.ts";

type ProgressRoutes = ApiClient["api"]["progress"];
type ReadRoute = ProgressRoutes["$get"];
type PinRoute = ProgressRoutes["pins"]["$post"];
type UnpinRoute = ProgressRoutes["pins"]["$delete"];
type TickRoute = ProgressRoutes["ticks"]["$post"];
type UntickRoute = ProgressRoutes["ticks"]["$delete"];
type ProgramsRoute = ApiClient["api"]["programs"]["$put"];
type RequirementsRoute = ApiClient["api"]["requirements"]["$get"];

type Answer = InferResponseType<ReadRoute>;
type ServedProgress = Extract<Answer, { programs: unknown }>;

/** One chosen Program, evaluated or not, as the API serves it. */
export type ProgramProgress = ServedProgress["programs"][number];
export type EvaluatedProgram = Extract<ProgramProgress, { status: "evaluated" }>;
/** One node of a Program's Requirement tree, in both lenses. */
export type EvaluatedRequirement = EvaluatedProgram["progress"]["requirements"][number];
export type SolverWarning = ServedProgress["solverWarnings"][number];
export type ProgramsWarning = ServedProgress["programWarnings"][number];
export type PinWarning = ServedProgress["pinWarnings"][number];
export type EngineWarning = EvaluatedProgram["progress"]["warnings"][number];

/** Why the API would not serve or edit Progress: the State File's refusals. */
export type ProgressRefusal = Extract<Answer, { reason: unknown }>["reason"];

/** The revision Progress was read from, and what a Pin or a tick is based on. */
export type ProgressVersion = ServedProgress["version"];

export type ProgressResult =
  | {
      kind: "served";
      programs: ProgramProgress[];
      stoppedEarly: boolean;
      solverWarnings: SolverWarning[];
      programWarnings: ProgramsWarning[];
      pinWarnings: PinWarning[];
      version: ProgressVersion;
    }
  | { kind: "refused"; reason: ProgressRefusal | undefined }
  /** This page has no launch token, so the server will not talk to it (ADR-0004). */
  | { kind: "unauthorized" }
  /** An answer arrived whose body this page cannot read; nothing is known about the file. */
  | { kind: "unreadable-answer" }
  /** The request never arrived. */
  | { kind: "unreachable" };

type Sent = Response & { ok: boolean; status: number };

async function read(answer: Sent): Promise<ProgressResult> {
  if (!answer.ok) {
    // widened: the launch token guard answers before the route does (`../body.ts`)
    const status: number = answer.status;
    if (status === UNAUTHORIZED) return { kind: "unauthorized" };
    const refused = await readBody(() => answer.json() as Promise<{ reason?: ProgressRefusal }>);
    if (!refused.readable) return { kind: "unreadable-answer" };
    return { kind: "refused", reason: refused.body.reason };
  }
  const served = await readBody(() => answer.json() as Promise<ServedProgress>);
  if (!served.readable) return { kind: "unreadable-answer" };
  const body = served.body;
  return {
    kind: "served",
    programs: body.programs,
    stoppedEarly: body.stoppedEarly,
    solverWarnings: body.solverWarnings ?? [],
    programWarnings: body.programWarnings ?? [],
    pinWarnings: body.pinWarnings ?? [],
    version: body.version,
  };
}

/** Sends one request; only the request failing is the server not being there. */
async function ask(send: () => Promise<Sent>): Promise<ProgressResult> {
  let answer: Sent;
  try {
    answer = await send();
  } catch {
    return { kind: "unreachable" };
  }
  return read(answer);
}

/** Progress for the student's chosen Programs, recomputed by the server now. */
export function fetchProgress(client: ApiClient): Promise<ProgressResult> {
  return ask(() => client.api.progress.$get());
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
export async function fetchRequirementsFiles(
  client: ApiClient,
): Promise<ListedRequirements[] | undefined> {
  let answer: Sent;
  try {
    answer = await client.api.requirements.$get();
  } catch {
    return undefined;
  }
  if (!answer.ok) return undefined;
  const served = await readBody(
    () => answer.json() as Promise<Extract<InferResponseType<RequirementsRoute>, { files: unknown }>>,
  );
  return served.readable ? served.body.files : undefined;
}

/** What choosing the Programs came to: saved, or why not. */
export type ProgramsChoice =
  | { kind: "saved" }
  | { kind: "refused"; reason: ProgressRefusal | undefined }
  | { kind: "unauthorized" }
  | { kind: "unreadable-answer" }
  | { kind: "unreachable" };

/** Chooses the student's Programs, on the revision the view was read from. */
export async function choosePrograms(
  client: ApiClient,
  programs: { requirementsFile: string; track?: string }[],
  basedOn: ProgressVersion,
): Promise<ProgramsChoice> {
  const request = { json: { programs, basedOn } } as InferRequestType<ProgramsRoute>;
  let answer: Sent;
  try {
    answer = await client.api.programs.$put(request);
  } catch {
    return { kind: "unreachable" };
  }
  if (answer.ok) return { kind: "saved" };
  const status: number = answer.status;
  if (status === UNAUTHORIZED) return { kind: "unauthorized" };
  const refused = await readBody(() => answer.json() as Promise<{ reason?: ProgressRefusal }>);
  return refused.readable ? { kind: "refused", reason: refused.body.reason } : { kind: "unreadable-answer" };
}
