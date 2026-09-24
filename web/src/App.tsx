import { useEffect, useState } from "react";
import { useWorkspaceChanges } from "./changes.ts";
import { DIRECTION, type Language } from "./i18n/strings.ts";
import { TimetableScreen } from "./timetable/TimetableScreen.tsx";

/**
 * Opening the app lands on the Timetable (docs/design.md, "Screens").
 *
 * The language lives here because `dir` and `lang` belong on the root element: switching
 * to Hebrew has to flip the whole document, not one pane of it.
 *
 * Watching the Workspace lives here for the same reason: a file appearing in the folder is
 * news for the whole app and not for one pane of it, so it is asked for once here and
 * handed to whichever screen is open (docs/design.md, "Storage").
 */
export function App({ language: initial = "en" as Language }): React.JSX.Element {
  const [language, setLanguage] = useState<Language>(initial);
  const workspaceChanges = useWorkspaceChanges();

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = DIRECTION[language];
  }, [language]);

  return (
    <TimetableScreen
      language={language}
      onLanguage={setLanguage}
      workspaceChanges={workspaceChanges}
    />
  );
}
