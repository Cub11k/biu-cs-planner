import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { DIRECTION, t, type Language } from "./i18n/strings.ts";

type Health = "checking" | "reachable" | "unreachable";

const HEALTH_STRING = {
  checking: "apiChecking",
  reachable: "apiReachable",
  unreachable: "apiUnreachable",
} as const;

export function App({ language = "en" as Language }): React.JSX.Element {
  const [health, setHealth] = useState<Health>("checking");

  useEffect(() => {
    let current = true;

    api.api.health
      .$get()
      .then((response) => {
        if (current) setHealth(response.ok ? "reachable" : "unreachable");
      })
      .catch(() => {
        if (current) setHealth("unreachable");
      });

    return () => {
      current = false;
    };
  }, []);

  return (
    <main dir={DIRECTION[language]} className="min-h-dvh p-8">
      <h1 className="text-2xl font-semibold">{t(language, "appName")}</h1>
      <p className="mt-2 text-accent">{t(language, HEALTH_STRING[health])}</p>
    </main>
  );
}
