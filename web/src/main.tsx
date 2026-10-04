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
// something the app never wrote. `SchemeControl` reads the same answer in order to *show* it,
// and stamps nothing as it mounts, so this line and the watcher below are the whole of how the
// attribute gets onto the document before a student touches anything (#168).
applyScheme(document.documentElement, storedScheme(schemeStore()));

// From here the tab follows the store rather than its memory of it: a choice made in another
// tab on this origin re-stamps this one without a reload (#146). The listener is meant to
// live as long as the page, so the stop function it returns is not kept.
//
// This is started **before** `createRoot` and that order is load-bearing. `render` schedules
// the mount rather than performing it, so a choice made in another tab can arrive between this
// line and the control's first commit; the watcher being up already is what puts it on the
// document, and `SchemeControl` re-reading the store in its own mount effect is what keeps the
// word it shows from contradicting that. The pair is #168: before it, the control's effect
// stamped the choice its render had captured, so an event landing in that window was applied
// here and then overwritten with the older value.
watchScheme(window, schemeStore(), document.documentElement);

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
