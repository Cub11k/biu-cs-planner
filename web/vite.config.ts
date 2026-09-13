import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dev server proxies to the API so the browser sees one origin, which keeps the
// strict CSP and the Origin checks from docs/design.md honest in development too.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:8900", changeOrigin: false },
    },
  },
});
