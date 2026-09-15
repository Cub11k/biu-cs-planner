import { expect, it } from "vitest";
import { DIRECTION, LANGUAGES, t } from "./strings.ts";

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
