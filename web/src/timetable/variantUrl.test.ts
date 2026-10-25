import { expect, it } from "vitest";
import { keepVariantInUrl, semesterInUrl, variantInUrl, type VariantUrlBrowser } from "./variantUrl.ts";

/** A browser that is only a URL, written through `replaceState` as the real one is. */
function browser(search: string): VariantUrlBrowser {
  const location = { pathname: "/", search, hash: "" };
  return {
    location,
    history: {
      replaceState: (_data: unknown, _unused: string, next?: string | URL | null) => {
        location.search = new URL(String(next), "http://localhost").search;
      },
    },
  };
}

const FALL = { academicYear: 2027, semester: "fall" } as const;
const SPRING = { academicYear: 2027, semester: "spring" } as const;

it("honours a Variant only for the Semester the URL stored it with (#345's item 3)", () => {
  const url = browser("?year=2027&semester=fall&variant=B&position=1");

  expect(variantInUrl(url, FALL)).toEqual({ name: "B", position: 1 });
  expect(variantInUrl(url, SPRING)).toBeUndefined();
  expect(variantInUrl(url, { academicYear: 2028, semester: "fall" })).toBeUndefined();
  // a URL from before the Semester was kept names no Semester, so its Variant is no Semester's
  expect(variantInUrl(browser("?variant=B"), FALL)).toBeUndefined();
});

it("reads the Semester the URL names, and nothing from one it cannot read", () => {
  expect(semesterInUrl(browser("?year=2028&semester=summer"))).toEqual({ academicYear: 2028, semester: "summer" });
  expect(semesterInUrl(browser("?year=2028&semester=winter"))).toBeUndefined();
  expect(semesterInUrl(browser("?year=twenty&semester=fall"))).toBeUndefined();
  expect(semesterInUrl(browser("?semester=fall"))).toBeUndefined();
});

it("writes the Semester with the Variant, and drops the Variant when none is shown", () => {
  const url = browser("?variant=B&position=1&other=kept");

  keepVariantInUrl(url, SPRING, undefined);
  expect(Object.fromEntries(new URLSearchParams(url.location.search))).toEqual({
    other: "kept",
    year: "2027",
    semester: "spring",
  });

  keepVariantInUrl(url, SPRING, { name: "Plan", position: 0 });
  expect(variantInUrl(url, SPRING)).toEqual({ name: "Plan", position: 0 });
});
