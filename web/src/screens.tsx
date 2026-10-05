import type { ScreenDefinition } from "./AppShell.tsx";
import { PLAN_SCREEN } from "./plan/PlanScreen.tsx";
import { PROGRESS_SCREEN } from "./progress/ProgressScreen.tsx";
import { TIMETABLE_SCREEN } from "./timetable/TimetableScreen.tsx";

/**
 * The screens that are built, in the order the navigation lists them (#294). The first is the
 * landing screen, which is the Timetable, and the rest follow `docs/design.md`'s order ("Screens"):
 * the Plan (#292), then Progress.
 *
 * **Only what is built.** A screen is added here by the ticket that builds it, never as a
 * placeholder: a screen in the navigation that shows nothing is a dead end, and the shell leaves a
 * screen that is not here out of the navigation altogether.
 */
export const SCREENS: readonly ScreenDefinition[] = [TIMETABLE_SCREEN, PLAN_SCREEN, PROGRESS_SCREEN];
