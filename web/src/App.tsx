import { useEffect } from "react";
import { hasLaunchToken } from "./api.ts";
import { useWorkspaceChanges } from "./changes.ts";
import { DIRECTION, type Language } from "./i18n/strings.ts";
import { useSettings } from "./settings.ts";
import { TimetableScreen } from "./timetable/TimetableScreen.tsx";

/**
 * Opening the app lands on the Timetable (docs/design.md, "Screens").
 *
 * The language lives here because `dir` and `lang` belong on the root element: switching to
 * Hebrew has to flip the whole document, not one pane of it.
 *
 * **It is no longer this component's own state.** It used to be a `useState` seeded from a prop,
 * so a student who switched to Hebrew was back in English on the next reload — the whole of #115.
 * It now comes from the State File over the API (`./settings.ts`), which ADR-0014 is the decision
 * for: a preference about the person belongs where the data is, not in the browser's store.
 *
 * Watching the Workspace is also what makes a page whose launch token has been retired find out
 * on its own: a refused poll is reported rather than discarded, which re-reads every pane, and
 * each pane then says what it is (#126, `./changes.ts`).
 *
 * Watching the Workspace lives here for the same reason the language does: a file appearing in the
 * folder is news for the whole app and not for one pane of it, so it is asked for once here and
 * handed to whichever screen is open, and to `useSettings`, which re-reads the language when
 * another tab or an editor changes it (docs/design.md, "Storage").
 *
 * **The first paint is `en`/`ltr`** and the document flips when the answer lands. `./settings.ts`
 * carries the argument, including why `navigator.language` does not seed it. Two things would make
 * that flash smaller and neither is available here: a blocking inline script in `index.html`, which
 * would have no synchronous answer to apply because the language is not in `localStorage`, and
 * holding the first paint, which needs a timeout for an answer that may never come.
 */
export function App(): React.JSX.Element {
  const workspaceChanges = useWorkspaceChanges();
  /**
   * Whether this page is holding a launch token, which is what tells a **retired** token from
   * **no** token in everything the screen says about a 401 (#126, `./api.ts`).
   *
   * Read on every render rather than once, and that is what makes it true over time: a tab on
   * the same port picks up a fresh token as soon as the new address is opened in that browser,
   * because the token comes from the origin's own store per request (ADR-0004). The poll is what
   * re-renders this — a refused ask, and the first answered one after it, are both reported
   * (`./changes.ts`) — so the fact is re-read within one interval of either happening.
   */
  const tokenHeld = hasLaunchToken();
  const settings = useSettings({ changes: workspaceChanges });
  const { choose } = settings;

  useEffect(() => {
    document.documentElement.lang = settings.language;
    document.documentElement.dir = DIRECTION[settings.language];
  }, [settings.language]);

  return (
    <TimetableScreen
      language={settings.language}
      // `undefined` while the settings have not been read, or while a change is in flight: the
      // switch is then a control that cannot be honoured, and `useSettings` decides which it is
      onLanguage={choose && ((language: Language): void => choose({ language }))}
      settingsNotice={settings.notice}
      settingsWarnings={settings.warnings}
      settingsUnread={settings.unread}
      // A preference change writes the State File, so the screen's revision is spent the moment one
      // lands — and the poll would tell it up to `DEFAULT_EVERY_MS` later, which is seconds in which
      // a click on a Group comes back `state-file-changed` and the student reads that their click
      // was not saved because of a language switch they made themselves. Counted in here so the
      // screen re-reads at once. `onEdited` is the same fix pointing the other way.
      workspaceChanges={workspaceChanges + settings.writes}
      onEdited={settings.ask}
      tokenHeld={tokenHeld}
    />
  );
}
