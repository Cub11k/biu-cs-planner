import { expect, it } from "vitest";
import { screenFor } from "./route.ts";

/** Which screen a path opens (#294): its own, or the landing screen for any other path. */
const SCREENS = [{ path: "/" }, { path: "/progress" }] as const;

it("opens the screen whose path it is", () => {
  expect(screenFor(SCREENS, "/progress")).toBe(SCREENS[1]);
  expect(screenFor(SCREENS, "/")).toBe(SCREENS[0]);
});

it("opens the landing screen, the first, for a path no screen has", () => {
  expect(screenFor(SCREENS, "/plan")).toBe(SCREENS[0]);
  expect(screenFor(SCREENS, "")).toBe(SCREENS[0]);
  // a path is matched whole, never by prefix
  expect(screenFor(SCREENS, "/progress/extra")).toBe(SCREENS[0]);
});

it("opens nothing when nothing is built", () => {
  expect(screenFor([], "/")).toBeUndefined();
});
