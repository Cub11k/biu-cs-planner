import { useEffect, useId, useState } from "react";
import { t, type Language, type StringKey } from "./i18n/strings.ts";
import {
  asSchemeChoice,
  chooseScheme,
  onSchemeChanged,
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
 *
 * **What it keeps is the word, never the attribute (#168).** Among the modules `web/src`
 * ships, `scheme.ts` owns `data-theme`: `main.tsx` stamps it before React mounts and
 * `watchScheme` re-stamps it whenever the store changes anywhere else, so there is nothing for
 * this component to correct and no state of the page it has to reproduce. (`web/index.html`'s
 * blocking script stamps it first, before any module runs; `scheme.ts`'s module header is the
 * full list of writers, #246.) It writes `<html>` in exactly one place — `chooseScheme`, in the
 * `change` handler, which is the one moment the browser will tell nobody else about. Its
 * `useState` is therefore only what the `<select>` displays, and the `choice` a render
 * captured never reaches the document; before #168 it did, through a mount effect, which is
 * how a choice from another tab could be applied and then overwritten by an older one.
 */
export function SchemeControl({ language }: { language: Language }): React.JSX.Element {
  // The word to show. Read during the render so the first paint of the control has one, and
  // read again at commit below, because by then it can be out of date.
  const [choice, setChoice] = useState<SchemeChoice>(() => storedScheme(schemeStore()));
  const controlId = useId();

  useEffect(() => {
    const store = schemeStore();
    // Subscribe first, then read: a change landing between the two would be missed the other
    // way round, and this is the only subscription — picking the option already shown fires no
    // `change` event, so a word this control got wrong is a word its student cannot correct.
    const stop = onSchemeChanged(window, store, setChoice);
    // The re-read #168 asks for. `choice` above was read in the render phase, and React may
    // yield before the commit this effect runs in; the store is what the document follows, so
    // the store is what the word follows too. It stamps nothing: that is `scheme.ts`'s.
    setChoice(storedScheme(store));
    return stop;
  }, []);

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
          // Remembered and stamped in one step, because no `storage` event comes back to the
          // tab that wrote the value — this is the one writer of `<html>` outside `scheme.ts`'s
          // own watcher, and `setChoice` is only the word catching up with it.
          chooseScheme(schemeStore(), document.documentElement, next);
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
