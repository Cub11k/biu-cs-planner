import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePackage } from "./stage.ts";

/**
 * `npm run build:package`: the repository's own build, staged into `dist/` ready to pack.
 * The work is in `stage.ts`, which takes its roots as arguments so that
 * `tools/package/shipped.test.ts` can run the same copy against a throwaway root and pack
 * it (#211). This file is the one place that names the repository.
 */
const root = fileURLToPath(new URL("../../", import.meta.url));

const shipped = await stagePackage({ root, builtUi: join(root, "web", "dist") });

console.log(`dist/cli.js and dist/ui/ (${shipped.length} entries) are ready to pack.`);
