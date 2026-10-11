import type { ComponentProps } from "react";
import { t, type Language, type StringKey } from "../i18n/strings.ts";
import { unauthorizedSaid } from "../AppShell.tsx";
import { CoursePicker } from "./CoursePicker.tsx";
import type { CatalogWarning, OfferingsResult } from "./offerings.ts";

/** What the Catalog pane is showing: nothing read yet, or the answer the API gave. */
export type CatalogState = { kind: "loading" } | OfferingsResult;

/**
 * Why the API served no Catalog, said in words the student can act on. A Warning nobody
 * can read is not a Warning, and the four reasons ask for four different things.
 */
const WARNING_STRING = new Map<CatalogWarning["kind"], StringKey>([
  ["file-unreadable", "warningFileUnreadable"],
  ["schema-version-too-new", "warningSchemaTooNew"],
  ["schema-version-unsupported", "warningSchemaUnsupported"],
]);

/** Absence is not a fault: the year simply has no Catalog yet, and one can be imported. */
const isAbsence = (warnings: readonly CatalogWarning[]): boolean =>
  warnings.length === 0 || warnings.every((warning) => warning.kind === "no-catalog-for-year");

/**
 * The Catalog pane, below the Tray in the left column (#283): this Semester's Catalog to search
 * and add from, or the account of why there is none. The Catalog's own answer, apart from the
 * State File's, so each says what became of its own read.
 */
export function CatalogPane({
  language,
  tokenHeld,
  catalog,
  academicYear,
  ...picker
}: {
  language: Language;
  tokenHeld: boolean;
  catalog: CatalogState;
  /** Spelled as the header spells it, so the screen names one year once. */
  academicYear: string;
} & Omit<ComponentProps<typeof CoursePicker>, "language">): React.JSX.Element {
  return (
    <aside className="flex min-h-0 flex-1 flex-col">
      {catalog.kind === "loading" ? (
        <p className="text-sm text-pencil">{t(language, "catalogLoading")}</p>
      ) : catalog.kind === "unreachable" ? (
        <p className="text-sm text-pencil">{t(language, "apiUnreachable")}</p>
      ) : catalog.kind === "unauthorized" ? (
        <p className="text-sm text-pencil">{unauthorizedSaid(language, tokenHeld)}</p>
      ) : /*
           An answer this page could not read. Its own branch and **before** the fall-through,
           because the fall-through is `CoursePicker` over an empty Catalog — a sidebar that
           silently shows no Course and says nothing, which is #171's failure exactly.
         */
      catalog.kind === "unreadable-answer" ? (
        <p className="text-sm text-pencil">{t(language, "catalogAnswerUnreadable")}</p>
      ) : catalog.kind === "not-served" || catalog.kind === "refused" ? (
        <CatalogNotice
          language={language}
          academicYear={academicYear}
          warnings={catalog.kind === "not-served" ? catalog.warnings : []}
          workspaceRefused={catalog.kind === "refused"}
        />
      ) : (
        <CoursePicker language={language} {...picker} />
      )}
    </aside>
  );
}

/**
 * What the screen says when the API served no Catalog. Absence asks the student to import
 * a crawl; a file that is there but unreadable asks for something else entirely, so the
 * Warnings the API sent decide which it is and are shown rather than swallowed.
 */
export function CatalogNotice({
  language,
  academicYear,
  warnings,
  workspaceRefused = false,
}: {
  language: Language;
  /** Spelled as the header spells it, so the screen names one year once. */
  academicYear: string;
  warnings: readonly CatalogWarning[];
  /** The Workspace would not touch the file: a refusal, not one of the Warnings (#149). */
  workspaceRefused?: boolean;
}): React.JSX.Element {
  return (
    <div className="text-sm text-pencil">
      <p>
        {!workspaceRefused && isAbsence(warnings)
          ? t(language, "catalogMissing", { year: academicYear })
          : t(language, "catalogUnreadable", { year: academicYear })}
      </p>
      <ul className="mt-2 list-disc space-y-1 ps-5">
        {workspaceRefused ? <li>{t(language, "catalogRefusedByWorkspace")}</li> : null}
        {warnings.map((warning) => {
          const key = WARNING_STRING.get(warning.kind);
          return key === undefined ? null : <li key={warning.kind}>{t(language, key)}</li>;
        })}
      </ul>
    </div>
  );
}
