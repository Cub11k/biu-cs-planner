/**
 * The Catalog as the HTTP API hands it over.
 *
 * `web` may not import `core` or `app` (CLAUDE.md, "Code guardrails"), so these types are
 * read off the typed client's own response type. The API contract is the only thing this
 * side of the boundary knows, and because the contract is inferred from the Zod schemas
 * the server validates against, these cannot drift from them (docs/design.md).
 */
import type { InferResponseType } from "hono/client";
import type { api } from "../api.ts";
import type { Language } from "../i18n/strings.ts";

type OfferingsAnswer = InferResponseType<(typeof api.api.catalog)[":year"]["offerings"]["$get"]>;

/** The answer that carries Offerings; the others carry Warnings and no Catalog. */
type ServedOfferings = Extract<OfferingsAnswer, { offerings: unknown }>;

export type Offering = ServedOfferings["offerings"][number];
export type Group = Offering["groups"][number];
export type Meeting = Group["meetings"][number];
export type Semester = Meeting["semester"];
export type Day = Meeting["day"];

/**
 * In English mode a Course with no English name shows its Hebrew name, because a Course
 * the student cannot name is worse than one named in the other language
 * (docs/design.md, "Language and direction").
 */
export function courseName(offering: Offering, language: Language): string {
  if (language === "he") return offering.nameHebrew;
  return offering.nameEnglish ?? offering.nameHebrew;
}

/**
 * A Year-long Offering carries the Meetings of both its Semesters, so a Timetable for one
 * Semester has to ask for that Semester's Meetings rather than for the Group's
 * (CONTEXT.md, "Year-long Course"; docs/research/shoham-raw-shape.md).
 */
export function meetingsInSemester(
  group: { meetings: readonly Meeting[] },
  semester: Semester,
): Meeting[] {
  return group.meetings.filter((meeting) => meeting.semester === semester);
}

/**
 * An Untimed Group has no Meetings at all in this Semester — an online Course, or one
 * Shoham has not published times for yet. It belongs in the "No fixed time" strip and
 * never on the grid (CONTEXT.md, "Untimed Group"; docs/design.md, "Grid and Picks").
 */
export function isUntimedIn(group: { meetings: readonly Meeting[] }, semester: Semester): boolean {
  return meetingsInSemester(group, semester).length === 0;
}
