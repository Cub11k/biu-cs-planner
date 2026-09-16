/**
 * Whether this machine can draw Hebrew at all.
 *
 * Every geometry assertion in this suite passes against tofu boxes, because boxes have
 * widths: a column is still to the right of another one, a tile still sits inside it, a
 * time range still reads left to right. A green run on a runner with no Hebrew font is
 * worse than no run, because it is a report that the Hebrew screen works.
 *
 * So this is the guard the rest of the browser project rests on. Chromium ships no fonts
 * of its own and Playwright's `--with-deps` installs libraries rather than typefaces, so
 * on a bare runner the answer here is no — and CI installs `fonts-noto-core` deliberately
 * rather than hoping (issue #45).
 */
import { expect, it } from "vitest";
import "./index.css";

/**
 * Ten Hebrew letters of visibly different widths — yod is the narrowest letter there is
 * and shin one of the widest — so a font that draws them all the same is drawing none
 * of them.
 */
const HEBREW = "אבגדהוזחטי";

/**
 * A code point Unicode has never assigned and never will in this block, repeated to the
 * same length. Whatever a missing glyph looks like on this machine, this is it: the
 * baseline every unrenderable character collapses onto.
 */
const NEVER_ASSIGNED = "͸";

/**
 * The width one string takes in the page's own font stack.
 *
 * Appended to `body` rather than styled here, because `index.css` puts the stack on
 * `body` and the question is whether *that* stack draws Hebrew — measuring a probe with
 * a font-family of its own would answer about a different page. Large, so a difference
 * of a fraction of an em is not a difference of a fraction of a pixel.
 */
function renderedWidth(text: string): number {
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.insetInlineStart = "-9999px";
  probe.style.whiteSpace = "pre";
  probe.style.fontSize = "64px";
  probe.textContent = text;

  document.body.append(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();

  return width;
}

const MISSING_GLYPHS = [...HEBREW].map(() => NEVER_ASSIGNED).join("");

const ADVICE =
  "Chromium is drawing Hebrew as missing-glyph boxes on this machine. " +
  "Install a Hebrew font (on Debian and Ubuntu, fonts-noto-core) and run fc-cache -f.";

it("measures something, so a passing guard is not two zeros", () => {
  // If this went to zero the comparison below would hold for the wrong reason and the
  // guard would be decorative.
  expect(renderedWidth(MISSING_GLYPHS)).toBeGreaterThan(0);
  expect(renderedWidth(HEBREW)).toBeGreaterThan(0);
});

it("draws Hebrew with glyphs rather than with boxes", () => {
  // A font that has none of these letters draws every one of them as the same box, so
  // the string comes out exactly as wide as the same count of never-assigned code points.
  expect(renderedWidth(HEBREW), ADVICE).not.toBe(renderedWidth(MISSING_GLYPHS));
});

it("gives each Hebrew letter its own width", () => {
  const widths = new Set([...HEBREW].map(renderedWidth));

  // The second signal, independent of the first: boxes are all one width, and these ten
  // letters are not. It catches the case where a box happens to be as wide as the letter
  // it replaced, which the total would hide.
  expect(widths.size, ADVICE).toBeGreaterThan(1);
});
