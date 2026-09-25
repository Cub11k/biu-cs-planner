import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { claimToken } from "./api.ts";
import { applyScheme, schemeStore, storedScheme } from "./scheme.ts";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Before anything renders, and so before the first request: the launch token comes out
// of the URL fragment and into storage, and the URL is left the way a bookmark wants it.
claimToken();

// And before React mounts: the remembered scheme goes onto `<html>`, so a student who chose
// light on a dark machine does not watch the page change colour as the first render lands.
// `SchemeControl` reads the same answer, so it agrees with what is already there rather than
// correcting it.
//
// Not *before the first paint*, which is a stronger claim than this can make: a module script
// is deferred, so the browser may already have painted `body` in the machine's scheme by the
// time this line runs. Closing that last gap needs a blocking inline script in `index.html`,
// which is a different file and a different change.
applyScheme(document.documentElement, storedScheme(schemeStore()));

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
