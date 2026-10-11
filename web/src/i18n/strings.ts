import { planEnglish, planHebrew } from "./plan.ts";
import { progressEnglish, progressHebrew } from "./progress.ts";
import { shellEnglish, shellHebrew } from "./shell.ts";
import { timetableEnglish, timetableHebrew } from "./timetable.ts";

/**
 * Every UI string goes through translation files, and right-to-left support is
 * mandatory from the first component (docs/design.md, "Language and direction").
 *
 * A real i18n library with lazy-loaded message catalogs is its own ticket; this is the
 * smallest thing that keeps strings out of components in the meantime.
 *
 * Catalog data is not translated here. A Course name arrives from Shoham in both
 * languages and falls back to Hebrew when there is no English one; a Lesson Type arrives
 * as the Hebrew label Shoham printed, and `lessonType.ts` renders the ones we know in
 * English and shows the rest as the Catalog wrote them.
 */
export const LANGUAGES = ["en", "he"] as const;

export type Language = (typeof LANGUAGES)[number];

/**
 * Every English string, composed from one table per screen (`./shell.ts`, `./plan.ts`,
 * `./progress.ts`, `./timetable.ts`), so a feature adds its strings to its own screen's file and
 * two features on two screens never edit one file (#366).
 */
const english = { ...shellEnglish, ...planEnglish, ...progressEnglish, ...timetableEnglish } as const;

/**
 * A key in two tables would be one string silently winning the spread over the other, so a key
 * in more than one is a compile error naming it.
 */
type Tables = [typeof shellEnglish, typeof planEnglish, typeof progressEnglish, typeof timetableEnglish];
type KeysOf<T> = T extends unknown ? keyof T : never;
type InTwoTables<T extends readonly unknown[]> = T extends readonly [infer First, ...infer Rest]
  ? (keyof First & KeysOf<Rest[number]>) | InTwoTables<Rest>
  : never;
const noKeyInTwoTables: [InTwoTables<Tables>] extends [never] ? true : InTwoTables<Tables> = true;
void noKeyInTwoTables;

export type StringKey = keyof typeof english;

/**
 * Every key there is, so a test can walk them. Off the English object rather than written
 * out, because a hand-kept list's failure mode is quietly ceasing to be the list.
 */
export const STRING_KEYS = Object.keys(english) as StringKey[];

/** Typed against the English keys, so a missing Hebrew string is a compile error. */
const hebrew: Record<StringKey, string> = { ...shellHebrew, ...planHebrew, ...progressHebrew, ...timetableHebrew };

const strings: Record<Language, Record<StringKey, string>> = { en: english, he: hebrew };

export const DIRECTION: Record<Language, "ltr" | "rtl"> = { en: "ltr", he: "rtl" };

/**
 * A literal pattern, never one built from data: a placeholder is `{name}`, and the values
 * that fill it are substituted rather than interpolated into anything executable
 * (docs/design.md, "API and data rules"; ADR-0007).
 */
const PLACEHOLDER = /\{(\w+)\}/g;

export function t(
  language: Language,
  key: StringKey,
  values?: Readonly<Record<string, string | number>>,
): string {
  const template: string = strings[language][key];
  if (values === undefined) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values[name];
  return value === undefined ? whole : String(value);
  });
}
