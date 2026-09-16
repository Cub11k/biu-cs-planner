import { useEffect, useState } from "react";
import { DIRECTION, type Language } from "./i18n/strings.ts";
import { TimetableScreen } from "./timetable/TimetableScreen.tsx";

/**
 * Opening the app lands on the Timetable (docs/design.md, "Screens").
 *
 * The language lives here because `dir` and `lang` belong on the root element: switching
 * to Hebrew has to flip the whole document, not one pane of it.
 */
export function App({ language: initial = "en" as Language }): React.JSX.Element {
  const [language, setLanguage] = useState<Language>(initial);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = DIRECTION[language];
  }, [language]);

  return <TimetableScreen language={language} onLanguage={setLanguage} />;
}
