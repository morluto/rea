import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensureGeneratedFile } from "./lib/generated-file.mjs";

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown skill metadata option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "skills/reverse-engineer-anything/SKILL.md");
const current = await readFile(path, "utf8");
const { CATALOG_IDENTITY } = await import(
  `${pathToFileURL(join(root, "dist/catalogIdentity.js")).href}?${String(Date.now())}`
);
const withCount = current.replace(
  /^\s{2}tool_count:\s*\d+\s*$/mu,
  `  tool_count: ${String(CATALOG_IDENTITY.counts.mcp_tools)}`,
);
// Skill identity follows the installed instruction bundle. Runtime schema identity
// is still reported independently by doctor and binary_session.
const source = withCount.replace(
  /^ {2}catalog_digest:[^\r\n]*(?:\r?\n|$)/mu,
  "",
);

await ensureGeneratedFile({
  path,
  source,
  check: arguments_.has("--check"),
  generateCommand: "npm run docs:generate",
});
