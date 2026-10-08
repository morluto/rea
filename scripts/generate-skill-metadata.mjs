import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ensureGeneratedFile } from "./lib/generated-file.mjs";

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown skill metadata option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(root, "skill-src/reverse-engineer-anything");
const outputRoot = join(root, "skills/reverse-engineer-anything");
const check = arguments_.has("--check");
const current = (
  await readFile(join(sourceRoot, "SKILL.md"), "utf8")
).replaceAll("\r\n", "\n");
const { CATALOG_IDENTITY } = await import(
  `${pathToFileURL(join(root, "dist/catalogIdentity.js")).href}?${String(Date.now())}`
);
if (/^\s{2}(?:tool_count|catalog_digest):/mu.test(current))
  throw new Error(
    "Catalog metadata belongs in the generated skill, not skill-src",
  );
const versionLine = /^ {2}version: "[^"\r\n]+"$/mu;
if (!versionLine.test(current))
  throw new Error("Missing authored skill version");
const skillVersion = /^ {2}version: "([^"\r\n]+)"$/mu.exec(current)?.[1];
if (skillVersion === undefined)
  throw new Error("Missing authored skill version");
const source = current.replace(
  versionLine,
  `$&\n  tool_count: ${String(CATALOG_IDENTITY.counts.mcp_tools)}`,
);
const paths = await filePaths(sourceRoot);
const generatedSources = await Promise.all(
  paths.map(async (relativePath) => ({
    path: relativePath,
    source:
      relativePath === "SKILL.md"
        ? source
        : (await readFile(join(sourceRoot, relativePath), "utf8")).replaceAll(
            "\r\n",
            "\n",
          ),
  })),
);
const bundleManifest = `${JSON.stringify(
  {
    schema_version: 1,
    skill_name: "reverse-engineer-anything",
    skill_version: skillVersion,
    files: generatedSources.map(({ path, source }) => ({
      path,
      sha256: createHash("sha256").update(source).digest("hex"),
    })),
  },
  null,
  2,
)}\n`;
// Rebuild this owned output directory so removed references cannot survive a build.
if (!check) await rm(outputRoot, { recursive: true, force: true });
for (const generated of generatedSources) {
  const path = join(outputRoot, generated.path);
  if (!check) await mkdir(dirname(path), { recursive: true });
  await ensureGeneratedFile({
    path,
    source: generated.source,
    check,
    generateCommand: "npm run docs:generate",
  });
}
await ensureGeneratedFile({
  path: join(outputRoot, "bundle-manifest.json"),
  source: bundleManifest,
  check,
  generateCommand: "npm run docs:generate",
});
if (
  check &&
  JSON.stringify(await filePaths(outputRoot)) !==
    JSON.stringify(["bundle-manifest.json", ...paths].sort())
)
  throw new Error(
    "Generated skill file inventory drifted; run npm run docs:generate",
  );

async function filePaths(directory, prefix = "") {
  const paths = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory())
      paths.push(
        ...(await filePaths(join(directory, entry.name), relativePath)),
      );
    else if (entry.isFile()) paths.push(relativePath);
    else
      throw new Error(
        `Skill bundle requires regular files or directories: ${relativePath}`,
      );
  }
  return paths;
}
