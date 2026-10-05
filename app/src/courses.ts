import { parseCatalogFile, type LocalizedText, type Offering, type RequirementsFile } from "@biu-cs-planner/core";
import { readStateFile } from "./edit.ts";
import { DEFAULT_STATE_FILE } from "./picks.ts";
import { loadRequirementsFiles } from "./requirements.ts";
import { WorkspaceRefusedError, type CatalogRef, type Workspace } from "./workspace.ts";

/**
 * What the Plan screen needs to draw a Course on a card (#292): its name and its credits, for any
 * year — a future one included, which has no Catalog (ADR-0008).
 *
 * **Requirements Files first**: the chosen Programs' own, in their order, then every other file in
 * the order the Workspace lists them, so a Course's credits are the ones the credit-load check reads
 * (`checkPlan` takes them from the first Program whose file gives them). **A name the files do not
 * give comes from the most recent Catalog** the Workspace holds and can read. A Catalog's credits
 * are never taken: they are a sum of weekly hours, not the Course's credits, and the Plan is checked
 * against the Requirements File alone (`docs/design.md`, "Plan").
 *
 * **A read, and never a refusal.** A file or folder the Workspace will not read, or a State File it
 * cannot parse, only means fewer Courses are known; the card then shows the course number alone.
 * Nothing here writes, and no path goes in or out.
 */
export type CourseFacts = { courseNumber: string; name?: LocalizedText; credits?: number };

export type CoursesView = { courses: CourseFacts[] };

export type CoursesOptions = {
  /** Defaults to `DEFAULT_STATE_FILE`; a State File is named, never a path. */
  stateFile?: string;
};

/** The readable Requirements Files, the chosen Programs' before the rest. */
async function filesInOrder(workspace: Workspace, stateFile: string): Promise<RequirementsFile[]> {
  const loaded = await loadRequirementsFiles(workspace);
  if (loaded.kind === "refused") return [];
  const read = await readStateFile(workspace, stateFile);
  const chosen = "refused" in read ? [] : read.state.programs.map((program) => program.requirementsFile);
  const rank = (name: string): number => {
    const at = chosen.indexOf(name);
    return at < 0 ? chosen.length : at;
  };
  return loaded.files
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a.entry.listed.name) - rank(b.entry.listed.name) || a.index - b.index)
    .flatMap(({ entry }) => (entry.file === undefined ? [] : [entry.file]));
}

/** The Offerings of the most recent Catalog that can be read, or none. */
async function latestOfferings(workspace: Workspace): Promise<Offering[]> {
  let refs;
  try {
    refs = await workspace.list("catalog");
  } catch (error) {
    if (error instanceof WorkspaceRefusedError) return [];
    throw error;
  }
  const years = refs
    .filter((ref): ref is CatalogRef => ref.kind === "catalog")
    .sort((a, b) => b.academicYear - a.academicYear);
  for (const ref of years) {
    let stored: unknown;
    try {
      stored = await workspace.read(ref);
    } catch (error) {
      if (error instanceof WorkspaceRefusedError) continue;
      throw error;
    }
    const parsed = parseCatalogFile(stored);
    if (parsed.catalog !== undefined) return parsed.catalog.offerings;
  }
  return [];
}

/** Every Course the Requirements Files or the most recent Catalog know, with what they say of it. */
export async function readCourses(workspace: Workspace, options: CoursesOptions = {}): Promise<CoursesView> {
  const known = new Map<string, CourseFacts>();
  const facts = (courseNumber: string): CourseFacts => {
    let held = known.get(courseNumber);
    if (held === undefined) {
      held = { courseNumber };
      known.set(courseNumber, held);
    }
    return held;
  };

  for (const file of await filesInOrder(workspace, options.stateFile ?? DEFAULT_STATE_FILE)) {
    for (const course of file.courses) {
      const held = facts(course.number);
      if (held.name === undefined && course.name !== undefined) held.name = course.name;
      if (held.credits === undefined && course.credits !== undefined) held.credits = course.credits;
    }
  }

  for (const offering of await latestOfferings(workspace)) {
    const held = facts(offering.courseNumber);
    if (held.name === undefined) {
      held.name =
        offering.nameEnglish === undefined
          ? { he: offering.nameHebrew }
          : { he: offering.nameHebrew, en: offering.nameEnglish };
    }
  }

  return { courses: [...known.values()] };
}
