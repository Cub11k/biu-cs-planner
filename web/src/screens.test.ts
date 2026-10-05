import { expect, it } from "vitest";
import { SCREENS } from "./screens.tsx";

/**
 * The screens the app opens with (#294): what is built and nothing else, the Timetable first —
 * the landing screen — the Plan screen since #292, in `docs/design.md`'s order, and the Progress
 * screen since #288. The Courses and Workspace screens join when their tickets build them, never as
 * placeholders.
 */
it("lists the built screens, the Timetable first and at the root", () => {
  expect(SCREENS.map((screen) => [screen.path, screen.label])).toEqual([
    ["/", "timetable"],
    ["/plan", "plan"],
    ["/progress", "progress"],
  ]);
});
