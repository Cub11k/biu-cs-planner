import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { claimToken } from "./api.ts";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

// Before anything renders, and so before the first request: the launch token comes out
// of the URL fragment and into storage, and the URL is left the way a bookmark wants it.
claimToken();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
