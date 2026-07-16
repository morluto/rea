import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensureGeneratedFile } from "./lib/generated-file.mjs";

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown skill metadata option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = join(root, "skills/rea-analysis/SKILL.md");
const current = await readFile(path, "utf8");
const { CATALOG_IDENTITY } = await import(
  `${pathToFileURL(join(root, "dist/catalogIdentity.js")).href}?${String(Date.now())}`
);
const withCount = current.replace(
  /^\s{2}tool_count:\s*\d+\s*$/mu,
  `  tool_count: ${String(CATALOG_IDENTITY.counts.mcp_tools)}`,
);
const digestLine = `  catalog_digest: "${CATALOG_IDENTITY.digests.combined_sha256}"`;
const source = /^\s{2}catalog_digest:/mu.test(withCount)
  ? withCount.replace(
      /^\s{2}catalog_digest:\s*"[a-f0-9]{64}"\s*$/mu,
      digestLine,
    )
  : withCount.replace(/^(\s{2}tool_count:\s*\d+\s*)$/mu, `$1\n${digestLine}`);

await ensureGeneratedFile({
  path,
  source,
  check: arguments_.has("--check"),
  generateCommand: "npm run docs:generate",
});
