import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

/**
 * The third mechanical check: **one module in this repository follows a re-export chain.**
 *
 * `tools/pr-report/surface.ts`'s `declaringModule` is that module's walk, and #124 put it
 * there rather than leaving it in `calls.ts` because `calls.ts` already imports `surface.ts`,
 * so a follower kept there and imported back would be a cycle in the very module graph this
 * report draws. Two readers need the walk now — the call graph, to find the function a call
 * lands on, and `resolveReExports`, to find the declaration a signature and a `declaredIn`
 * are read from — and a third would be written by whoever next needs one and cannot find the
 * first.
 *
 * **What this replaces, and why.** #124 shipped the rule as a canary in
 * `tools/pr-report/surface.test.ts`: five hard-coded filenames, each read and searched for the
 * literal string `declaringModule`. It caught the walk being copied back into one of those
 * five files and nothing else — not a second follower in a sixth file, not one under another
 * name, not one reached through a different spelling, which is the thing the rule is about.
 * #179's implementer named it weak in its own report rather than letting it pass as coverage
 * (#203). So the check moved into this directory, where `moduleCycles`, `callCycles` and
 * `forbiddenEdges` live, and it asks what it means rather than searching for one identifier.
 *
 * **It reads the source itself**, which the other three do not: they take
 * `tools/pr-report/collect.ts`'s output, and `collect` walks `SOURCE_DIRS` — the four
 * workspaces — so it cannot see `tools/` at all, which is where the walk and every plausible
 * second one live. Reading the tree here is what makes "anywhere else" true.
 *
 * **Where it is enforced, exactly.** `followers.test.ts`'s whole-tree assertion, so a stray
 * follower fails `npm test` — which CI runs — the way `layering.test.ts` does for
 * `forbiddenEdges`. It is *not* in the pull request comment: `main.ts` does not call
 * `strayFollowers`, so unlike the other three this rule is tested and not reported. #203 did
 * not ask for the comment and reporting it means a field on `Graphs` and a paragraph in
 * `./render.ts`; that is its own ticket, and saying so here is cheaper than a reader inferring
 * a comment that does not exist.
 */

/** One source file, as this check reads them: a repo-relative path and its text. */
export type Source = { path: string; text: string };

/** A function this check reads as following a re-export chain, and where it is written. */
export type Follower = { path: string; name: string };

/**
 * The one module the walk may live in.
 *
 * A rule, not a list to search: `LAYERS` in `./layering.ts` names its workspaces the same way
 * and for the same reason. Where the five-filename canary enumerated the places a copy *might*
 * appear — and so went quiet about every place it did not name — this names the one place the
 * walk is allowed, and every follower found anywhere else is a finding. Moving the walk is
 * then a one-line edit here with the move, rather than a rule that silently stops applying.
 */
export const FOLLOWER_HOME = "tools/pr-report/surface.ts";

/**
 * Directory names this check does not descend into: dependencies, build output, the coverage
 * run's files, the repository's own metadata, and the session transcripts `.gitignore` keeps
 * untracked. Matched whole, like `collect.ts`'s own `SKIP`, so a `distant/` is not a `dist`.
 *
 * Nothing else is excluded. A file is read because the tree holds it, which is the difference
 * between this and the five-filename canary: there is no list of files anywhere, and a `.ts`
 * added tomorrow is covered the day it is written.
 *
 * Shorter than `collect.ts`'s `SKIP` by one entry on purpose: `__fixtures__` stays in, because a
 * walk is a walk wherever it is written and a fixture directory is exactly where a second one
 * would be parked "just for a test". `core/src/shoham/__fixtures__` holds JSON today, so this
 * excludes nothing now; it is a decision rather than an omission.
 */
const SKIP = new Set(["node_modules", "dist", "coverage", ".git", ".sessions"]);

/**
 * The two halves of a re-export origin, as the property names a follower reads them by.
 *
 * **Literal strings, and nothing is ever built from data** (ADR-0007): these are the field
 * names of `ExportOrigin` in `tools/pr-report/surface.ts`, written out here because that is
 * what a chain is followed *with* — the module a name comes from and the name it is known by
 * there, which is the pair #86 established either half of alone is too weak a key for. A
 * follower reads both, every time, because one step of a chain is that pair.
 */
const ORIGIN_SPECIFIER = "specifier";
const ORIGIN_NAME = "name";

/**
 * Every `.ts` and `.tsx` file under `root`, repo-relative, sorted.
 *
 * An entry that cannot be read is skipped rather than thrown out of: a dangling symlink or a
 * file removed mid-walk would otherwise take the whole check down, and a check that crashes on
 * one unreadable entry says nothing about the hundred and fifty it had already read.
 */
export function readSources(root: string): Source[] {
  const found: Source[] = [];

  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry)) continue;
      const full = join(dir, entry);
      let directory: boolean;
      try {
        directory = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (directory) {
        walk(full);
        continue;
      }
      // A literal pattern: a `.ts` or `.tsx` extension at the end of the name.
      if (!/\.tsx?$/.test(entry)) continue;
      try {
        found.push({
          path: relative(root, full).replaceAll("\\", "/"),
          text: readFileSync(full, "utf8"),
        });
      } catch {
        continue;
      }
    }
  };

  walk(root);
  return found.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * A function this check can report, with the name to report it under.
 *
 * **Every way of writing one, not only the two the walk happens to use.** A first draft read a
 * `function` declaration and a `const` holding an arrow, and a reviewer of #203 showed four
 * full re-export walks it was blind to: a class method, an object-literal method, an anonymous
 * `export default function`, and a named function expression assigned to a property. A rule
 * whose claim is "a second follower anywhere is a finding" cannot be answered by the spelling
 * someone chose, so each of those is a case here.
 *
 * An anonymous `export default function` is reported as `default`, which is the name it is
 * imported under and so the name a reader looks for.
 */
function named(node: ts.Node): { name: string; body: ts.Node } | undefined {
  if (ts.isFunctionDeclaration(node) && node.body) {
    return { name: node.name ? node.name.text : "default", body: node.body };
  }
  // A named function expression — `x.trace = function go() { … go(…) }` — is reported under its
  // own name, which is also the name it recurses by.
  if (ts.isFunctionExpression(node) && node.name) {
    return { name: node.name.text, body: node.body };
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.body) {
    return { name: node.name.text, body: node.body };
  }
  if (
    (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return { name: node.name.text, body: node.initializer.body };
  }
  return undefined;
}

/**
 * Every function in `sources` that follows a re-export chain.
 *
 * **The rule, as what it means.** A function follows a chain when it does both of the things
 * following one consists of:
 *
 * 1. **It resolves a step.** Somewhere in its body it reads a re-export origin's two halves —
 *    the specifier the name comes from and the name it is known by there. Either half alone is
 *    read all over this repository; the pair is what a step of a chain *is*.
 * 2. **It advances.** It calls itself, or it iterates. A chain is followed by repetition, and
 *    these are the two ways to write repetition, so a follower spelled as a `while` loop is
 *    caught exactly like the recursive one `declaringModule` happens to be. "Calls itself"
 *    includes `this.sameName(…)` and `self.sameName(…)`, so a walk written as a method is not
 *    missed for reaching itself through a receiver.
 *
 * Neither half mentions `declaringModule`, which is the point: #203 asks that the rule survive
 * the function being renamed, and nothing here would notice if it were. What it would notice is
 * a second walk in `tools/pr-review`, in `app/src`, in a test helper, or in a file written next
 * month that no list anywhere names.
 *
 * **It over-reports, and that is the direction chosen.** Any function that reads both halves of
 * an origin and repeats is matched, whether or not it follows anything: `readModule` in
 * `FOLLOWER_HOME` is the live example — it reads the pair off each export clause and loops over
 * the statements, and calls `declaringModule` nowhere. Three of this repository's functions are
 * reported and one walk exists. That is deliberate, because the two kinds of mistake are not
 * symmetrical: an extra name in a finding costs a reviewer a sentence, while a missing one is
 * the rule going quiet about the thing it exists for. A finding inside `FOLLOWER_HOME` is not
 * reported at all (see `strayFollowers`), so the over-reporting is invisible until someone adds
 * a function elsewhere that reads an origin in a loop — at which point a sentence of review is
 * the cost.
 *
 * `scan` descends into nested functions for the same reason: a walk written as an anonymous
 * inline callback has no name to report, and attributing it to the named function around it is
 * better than not seeing it. The price is that an outer function is reported beside a nested
 * one, which is noise in the list and not a gap in the rule.
 *
 * **What it does not see**, said out loud rather than left for a reader to assume: a pair of
 * functions that recurse through each other, a follower that reads the origin's halves through
 * a destructuring or a rename rather than a property access, one that puts the pair in a
 * variable in a different function, and a walk in a file this repository does not spell `.ts`
 * or `.tsx`. This is a structural check on syntax and not a proof, and the claim it makes is
 * the one above and no larger.
 */
export function reExportFollowers(sources: readonly Source[]): Follower[] {
  const found: Follower[] = [];

  for (const source of sources) {
    const file = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.ESNext, true);

    const visit = (node: ts.Node): void => {
      const fn = named(node);
      if (fn) {
        let specifier = false;
        let name = false;
        let recurses = false;
        let iterates = false;

        const scan = (inner: ts.Node): void => {
          if (ts.isPropertyAccessExpression(inner)) {
            if (inner.name.text === ORIGIN_SPECIFIER) specifier = true;
            if (inner.name.text === ORIGIN_NAME) name = true;
          }
          if (ts.isCallExpression(inner)) {
            // `go(…)`, and `this.go(…)` or `self.go(…)` — a method reaches itself through a
            // receiver, and the name after the dot is the same name either way.
            if (ts.isIdentifier(inner.expression) && inner.expression.text === fn.name) {
              recurses = true;
            }
            if (
              ts.isPropertyAccessExpression(inner.expression) &&
              inner.expression.name.text === fn.name
            ) {
              recurses = true;
            }
          }
          if (
            ts.isWhileStatement(inner) ||
            ts.isDoStatement(inner) ||
            ts.isForStatement(inner) ||
            ts.isForOfStatement(inner) ||
            ts.isForInStatement(inner)
          ) {
            iterates = true;
          }
          ts.forEachChild(inner, scan);
        };
        ts.forEachChild(fn.body, scan);

        if (specifier && name && (recurses || iterates)) {
          found.push({ path: source.path, name: fn.name });
        }
      }
      ts.forEachChild(node, visit);
    };

    ts.forEachChild(file, visit);
  }

  return found;
}

/**
 * The finding: every follower written outside the one module the walk belongs in.
 *
 * Empty is the clean state, exactly as `forbiddenEdges` returning `[]` is. A follower *inside*
 * `FOLLOWER_HOME` is not reported however many functions there are — the rule is one module,
 * and `resolveReExports` iterating over the pair beside `declaringModule` is the same walk's
 * own caller rather than a second walk.
 */
export function strayFollowers(sources: readonly Source[]): Follower[] {
  return reExportFollowers(sources).filter((f) => f.path !== FOLLOWER_HOME);
}

/**
 * A finding as a sentence, for the message a failing check prints.
 *
 * Today that is `followers.test.ts`'s whole-tree assertion and nothing else: `main.ts` builds
 * its `graphs` from the other three checks and does not call `strayFollowers`, so a stray
 * follower fails `npm test` — which CI runs — and is absent from the pull request comment the
 * other three are reported in. Said here rather than left to be discovered, because this
 * module's header calls the rule mechanical and a reader would reasonably expect the comment.
 */
export const explainFollower = (follower: Follower): string =>
  `\`${follower.path}\` follows a re-export chain in \`${follower.name}\`. This repository ` +
  `keeps one barrel-follower, \`declaringModule\` in \`${FOLLOWER_HOME}\`, because a second ` +
  `one imported back into \`tools/pr-report/calls.ts\` would close a cycle in the module ` +
  `graph this report draws (#124). Call the existing walk, or move it and say so here.`;
