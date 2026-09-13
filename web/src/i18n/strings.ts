/**
 * Every UI string goes through translation files, and right-to-left support is
 * mandatory from the first component (docs/design.md, "Language and direction").
 *
 * A real i18n setup with a language switch is its own ticket; this is the smallest
 * thing that keeps strings out of components in the meantime.
 */
export const LANGUAGES = ["en", "he"] as const;

export type Language = (typeof LANGUAGES)[number];

const strings = {
  en: {
    appName: "BIU CS Planner",
    apiChecking: "Checking the API…",
    apiReachable: "API reachable",
    apiUnreachable: "API unreachable",
  },
  he: {
    appName: "מתכנן מדעי המחשב בר־אילן",
    apiChecking: "בודק את ה-API…",
    apiReachable: "ה-API זמין",
    apiUnreachable: "ה-API אינו זמין",
  },
} as const satisfies Record<Language, Record<string, string>>;

export type StringKey = keyof (typeof strings)["en"];

export const DIRECTION: Record<Language, "ltr" | "rtl"> = { en: "ltr", he: "rtl" };

export function t(language: Language, key: StringKey): string {
  return strings[language][key];
}
