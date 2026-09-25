import { expect, it } from "vitest";
import { DIRECTION, LANGUAGES, STRING_KEYS, t } from "./strings.ts";

it("fills a placeholder with the value given for it", () => {
  expect(t("en", "catalogMissing", { year: 2027 })).toContain("2027");
  expect(t("en", "groupsCount", { count: 5 })).toBe("5 groups");
});

it("leaves a placeholder nobody filled alone rather than printing undefined", () => {
  expect(t("en", "groupsCount", {})).toBe("{count} groups");
});

it("answers in every language it offers, each with a direction", () => {
  for (const language of LANGUAGES) {
    expect(t(language, "timetable")).not.toBe("");
    expect(["ltr", "rtl"]).toContain(DIRECTION[language]);
  }
});

/**
 * A placeholder is the one part of a string a translator can silently drop, and the type
 * system cannot see it: `Record<StringKey, string>` says Hebrew has a row for `undoneEdit`,
 * not that the row still has `{edit}` in it. A translation that lost one would print a
 * sentence with a hole where the name of the edit belonged, in one language only.
 */
const placeholdersIn = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((found) => found[1]!).sort();

it("keeps every placeholder in every language, so a translation cannot lose one", () => {
  for (const key of STRING_KEYS) {
    const [first = "en", ...rest] = LANGUAGES;
    const expected = placeholdersIn(t(first, key));
    for (const language of rest) {
      expect(placeholdersIn(t(language, key)), `${key} in ${language}`).toEqual(expected);
    }
  }
});
