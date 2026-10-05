import type { ScreenDefinition } from "./AppShell.tsx";
import { TIMETABLE_SCREEN } from "./timetable/TimetableScreen.tsx";

/**
 * The screens that are built, in the order the navigation lists them (#294). The first is the
 * landing screen, which is the Timetable (`docs/design.md`, "Screens").
 *
 * **Only what is built.** A screen is added here by the ticket that builds it, never as a
 * placeholder: a screen in the navigation that shows nothing is a dead end, and the shell leaves a
 * screen that is not here out of the navigation altogether.
 */
export const SCREENS: readonly ScreenDefinition[] = [TIMETABLE_SCREEN];
