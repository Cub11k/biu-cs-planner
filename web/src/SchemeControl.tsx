import { useEffect, useId, useState } from "react";
import { t, type Language, type StringKey } from "./i18n/strings.ts";
import {
  applyScheme,
  asSchemeChoice,
  rememberScheme,
  SCHEME_CHOICES,
  schemeStore,
  storedScheme,
  type SchemeChoice,
} from "./scheme.ts";

/** The three choices, each as the translated word the student reads. */
const CHOICE_STRING = {
  system: "schemeSystem",
  light: "schemeLight",
  dark: "schemeDark",
} as const satisfies Record<SchemeChoice, StringKey>;

/**
 * The control that makes light and dark a choice rather than a report of the operating
 * system (docs/design.md, "Light and dark"; #114).
 *
 * A native `<select>` rather than a styled widget. Three states have to be reachable and
 * legible — light, dark, and handing the decision back to the machine — and a `<select>`
 * arrives keyboard-operable, announced with its value, and closable with Escape without a
 * line of code here. The visible focus ring is `index.css`'s `:focus-visible` rule, which
 * is a 2px outline in `--ink` and so follows the scheme the student just chose;
 * `scheme.browser.test.tsx` checks it is that ring and not the one Chromium draws by
 * itself — a test that cannot tell them apart would pass with the rule deleted — and checks
 * it under an explicit choice as well as under the machine's.
 *
 * **The scheme is state this component keeps, unlike the language.** `App.tsx` owns the
 * language because every string in the tree is rendered from it; nothing in the tree
 * renders from the scheme. It reaches `<html>`, `index.css` does the rest, and no other
 * component has a use for it — so threading it through two components as a prop pair would
 * buy nothing. `document` and `window` are touched here for that reason, and `scheme.ts`
 * stays free of both so its own tests need no browser.
 */
export function SchemeControl({ language }: { language: Language }): React.JSX.Element {
  // Read once, as this mounts: `main.tsx` has already stamped the same answer on `<html>`,
  // so this agrees with the document rather than correcting it.
  const [choice, setChoice] = useState<SchemeChoice>(() => storedScheme(schemeStore()));
  const controlId = useId();

  useEffect(() => {
    applyScheme(document.documentElement, choice);
  }, [choice]);

  return (
    /**
     * A `<label>` kept off the screen rather than an `aria-label`, which is the pattern
     * `timetable/CoursePicker.tsx` already uses for its search field: a real association
     * costs no visible space, and the header has none to give — it carries the screen's
     * title, the Semester, this and the language switch in one row.
     *
     * A fragment and not a wrapper, because `sr-only` takes the label out of flow: the
     * header's flex row is left exactly as it was, with `ms-auto` on the control.
     */
    <>
      <label className="sr-only" htmlFor={controlId}>
        {t(language, "schemeLabel")}
      </label>
      <select
        id={controlId}
        value={choice}
        onChange={(event) => {
          // Narrowed rather than cast: the value arrives as a `string`, and only the three
          // names are choices this app has a palette for.
          const next = asSchemeChoice(event.target.value);
          rememberScheme(schemeStore(), next);
          setChoice(next);
        }}
        className="ms-auto rounded-sm border border-rule bg-paper px-3 py-1 text-sm text-ink-soft"
      >
        {SCHEME_CHOICES.map((option) => (
          <option key={option} value={option}>
            {t(language, CHOICE_STRING[option])}
          </option>
        ))}
      </select>
    </>
  );
}
