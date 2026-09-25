import { t, type Language } from "./i18n/strings.ts";

/**
 * Undo and redo, in the Timetable header beside the screen's other controls (#144).
 *
 * Two plain `<button>`s, for the reason `SchemeControl` gives for its native `<select>`:
 * a button arrives keyboard-reachable, announced with the word on it, and pressed by Enter
 * and Space without a line of code here. It needs no `sr-only` label either — that pattern
 * exists for a control with no visible text of its own, and these have theirs.
 *
 * The visible focus state is `index.css`'s `:focus-visible` rule — a solid 2px outline in
 * `--ink`, so it follows the scheme the student chose. `history.browser.test.tsx` asserts
 * that ring rather than `matches(":focus-visible")`, because Chromium draws a ring of its
 * own and a test that cannot tell them apart would pass with the rule deleted.
 *
 * **Presentational on purpose.** It holds no state, sends no request and decides nothing: it
 * is told whether each direction can be taken and calls back when one is asked for. Whether
 * undo is available is the server's answer (`GET /api/history`), whether there is a revision
 * to step from is the screen's, and both reach here already resolved into two booleans — so
 * there is no third opinion here about either.
 */
export function HistoryControls({
  language,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  language: Language;
  /**
   * Already the conjunction of every reason the button may be pressed: the server saying the
   * stack is not empty, a revision on screen to step from, and no step already in flight.
   */
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}): React.JSX.Element {
  return (
    // `gap-1` between the pair, inside the header's own `gap-4` — they are one control read
    // together, not two of the header's four things. No directional class: the header's `dir`
    // puts undo before redo in both languages, which is on the right in Hebrew.
    <span className="flex items-center gap-1">
      <HistoryButton language={language} which="undo" enabled={canUndo} onPress={onUndo} />
      <HistoryButton language={language} which="redo" enabled={canRedo} onPress={onRedo} />
    </span>
  );
}

/**
 * One of the two. `disabled` rather than `aria-disabled`: an unavailable undo is not a thing
 * to tab to and be refused by, and `disabled` is the one a browser and a screen reader agree
 * about without help. The cost is that a disabled button is not focusable, which is why the
 * keyboard assertion drives the state where there *is* something to undo.
 */
function HistoryButton({
  language,
  which,
  enabled,
  onPress,
}: {
  language: Language;
  which: "undo" | "redo";
  enabled: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      // named for the test and the student alike: which of the two this is, in no language
      data-history={which}
      disabled={!enabled}
      onClick={onPress}
      className="rounded-sm border border-rule bg-paper px-3 py-1 text-sm text-ink-soft disabled:opacity-50"
    >
      {t(language, which)}
    </button>
  );
}
