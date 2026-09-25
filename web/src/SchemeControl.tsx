import { useEffect, useState } from "react";
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
 * itself, because a test that cannot tell them apart would pass with the rule deleted.
 *
 * **The scheme is state this component keeps, unlike the language.** `App.tsx` owns the
 * language because every string in the tree is rendered from it; nothing in the tree
 * renders from the scheme. It reaches `<html>`, `index.css` does the rest, and no other
 * component has a use for it — so threading it through two components as a prop pair would
 * buy nothing. `document` and `window` are touched here for that reason, and `scheme.ts`
 * stays free of both so its own tests need no browser.
 */
export function SchemeControl({ language }: { language: Language }): React.JSX.Element {
  // Read once, as this mounts: `main.tsx` has already stamped the same answer on `<html>`
  // before the first paint, so this agrees with the document rather than correcting it.
  const [choice, setChoice] = useState<SchemeChoice>(() => storedScheme(schemeStore()));

  useEffect(() => {
    applyScheme(document.documentElement, choice);
  }, [choice]);

  return (
    <select
      /**
       * A label and not a `<label>`: the header carries a heading, a Semester, this and the
       * language switch in one row, and a visible caption for each would crowd out the
       * screen's own title. The label is a translated string either way, and the selected
       * option is visible in the control, so what it is set to is never hidden.
       */
      aria-label={t(language, "schemeLabel")}
      value={choice}
      onChange={(event) => {
        // Narrowed rather than cast: the value arrives as a `string`, and only the three
        // names are choices this app has a palette for.
        const next = asSchemeChoice(event.target.value);
        rememberScheme(schemeStore(), next);
        setChoice(next);
      }}
      className="ms-auto rounded-sm border border-rule bg-paper px-2 py-1 text-sm text-ink-soft"
    >
      {SCHEME_CHOICES.map((option) => (
        <option key={option} value={option}>
          {t(language, CHOICE_STRING[option])}
        </option>
      ))}
    </select>
  );
}
