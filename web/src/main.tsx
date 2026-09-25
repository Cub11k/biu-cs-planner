import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { claimToken } from "./api.ts";
import { applyScheme, schemeStore, storedScheme, watchScheme } from "./scheme.ts";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Before anything renders, and so before the first request: the launch token comes out
// of the URL fragment and into storage, and the URL is left the way a bookmark wants it.
claimToken();

// And before React mounts: the remembered scheme, narrowed, onto `<html>`.
//
// `index.html`'s blocking stamp has already put the same key's value there, before the first
// paint, so this is not what stops a student seeing a flash — that happened earlier and in a
// file a module could not reach. What this line adds is the narrowing: the stamp copies the
// stored string as it found it and leaves `index.css` to recognise it, and `storedScheme` is
// where a string no palette matches becomes no choice at all. So this normally rewrites the
// value that is already on the element, and the one case it changes is a store holding
// something the app never wrote. `SchemeControl` reads the same answer, so it agrees with
// what is there rather than correcting it.
applyScheme(document.documentElement, storedScheme(schemeStore()));

// From here the tab follows the store rather than its memory of it: a choice made in another
// tab on this origin re-stamps this one without a reload (#146). The listener is meant to
// live as long as the page, so the stop function it returns is not kept.
//
// What this does not move is `SchemeControl`'s own `<select>`, which reads the store once as it
// mounts: the other tab's page turns dark while its drop-down still says what it said when that
// tab loaded. That is worse than a stale word, and the reason is the `<select>`: picking the
// option already selected fires no `change` event, so the one value a student in that tab
// cannot re-assert is the one the control is showing them — they have to pass through another
// option first. The palette is still right, which is why this is a gap and not a defect.
//
// The fix is one `useEffect` over `onSchemeChanged` inside that component. #146 carries the
// edit rather than making it, because the component belonged to another change in flight.
watchScheme(window, schemeStore(), document.documentElement);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
