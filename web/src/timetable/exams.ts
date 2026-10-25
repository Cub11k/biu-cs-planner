/**
 * Asking the API for one Variant's exam period (#419): the sittings in date order, the Exam Clashes
 * and spacing Warnings among them, and how many picked Courses have no published Exams. The check
 * is `core`'s (`checkExams`, through `readExams` in `app`); this only reads its answer.
 */
import type { InferRequestType, InferResponseType } from "hono/client";
import { askFor } from "../body.ts";
import type { ApiClient } from "./offerings.ts";
import { asRead, type TimetableQuery } from "./picks.ts";

type ExamsRoute = ApiClient["api"]["timetable"][":year"][":semester"]["exams"]["$get"];
type ServedExams = Extract<InferResponseType<ExamsRoute>, { exams: unknown }>;

/** One sitting on the rail: who, which Moed, when, the gap behind it, and whether it is Year-long (#214). */
export type RailSitting = ServedExams["exams"]["sittings"][number];
export type ExamWarning = ServedExams["exams"]["warnings"][number];
/** A sitting as a Warning names it. */
export type ExamSitting = Extract<ExamWarning, { kind: "exam-clash" }>["sittings"][number];

export type ExamPeriod = {
  /** The Variant the answer is about, which the rail checks against the week beside it. */
  variantName: string;
  sittings: RailSitting[];
  warnings: ExamWarning[];
  coursesWithUnknownExams: number;
  /** The student's own threshold, so the rail says what "too close" means here. */
  spacingDays: number;
};

/**
 * The exam period, or `undefined` for *not had* — a refusal, the guard, no server, or an answer this
 * page could not read. Never an empty exam period in its place: an answer that carries none says
 * nothing about the student's Exams (#184's ruling).
 */
export function fetchExams(client: ApiClient, query: TimetableQuery): Promise<ExamPeriod | undefined> {
  const request = {
    ...asRead(query),
    ...(query.variant === undefined
      ? {}
      : {
          query: {
            variant: query.variant,
            ...(query.position === undefined ? {} : { position: String(query.position) }),
          },
        }),
  } as InferRequestType<ExamsRoute>;
  return askFor(
    () => client.api.timetable[":year"][":semester"].exams.$get(request),
    (body: ServedExams): ExamPeriod | undefined =>
      // the rail loops over both lists, so an answer without them is not an exam period (#275)
      Array.isArray(body.exams?.sittings) && Array.isArray(body.exams.warnings)
        ? {
            variantName: body.variantName,
            sittings: body.exams.sittings,
            warnings: body.exams.warnings,
            coursesWithUnknownExams: body.exams.coursesWithUnknownExams,
            spacingDays: body.spacingDays,
          }
        : undefined,
  );
}
