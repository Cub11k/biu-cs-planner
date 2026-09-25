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

// And before the first paint: the remembered scheme goes onto `<html>`, so a student who
// chose light on a dark machine is not shown a dark page for the frame it takes React to
// mount. `SchemeControl` reads the same answer and so agrees with what is already there.
applyScheme(document.documentElement, storedScheme(schemeStore()));

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
