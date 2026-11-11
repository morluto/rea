import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { syncCursorPluginSkill } from "./lib/cursor-plugin-bundle.mjs";

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown Cursor plugin skill option: ${argument}`);

await syncCursorPluginSkill({
  root: join(dirname(fileURLToPath(import.meta.url)), ".."),
  check: arguments_.has("--check"),
});
