import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateBuildCache } from "./build-cache.mjs";
import { ensureGeneratedFile } from "./lib/generated-file.mjs";

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown package metadata option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);
const lock = JSON.parse(
  await readFile(join(root, "package-lock.json"), "utf8"),
);
const skill = await readFile(
  join(root, "skills/rea-analysis/SKILL.md"),
  "utf8",
);
const skillVersion = /^\s{2}version:\s*"([^"]+)"\s*$/mu.exec(skill)?.[1];
if (skillVersion === undefined)
  throw new Error("Missing rea-analysis skill metadata version");
const versionOf = (name) => {
  const value = lock.packages?.[`node_modules/${name}`]?.version;
  if (typeof value !== "string")
    throw new Error(`Missing locked ${name} version`);
  return value;
};
const source = `/** Generated from package.json and package-lock.json; do not edit. */
export const PACKAGE_METADATA = {
  name: ${JSON.stringify(packageJson.name)},
  version: ${JSON.stringify(packageJson.version)},
  serverSdkVersion: ${JSON.stringify(versionOf("@modelcontextprotocol/server"))},
  clientSdkVersion: ${JSON.stringify(versionOf("@modelcontextprotocol/client"))},
  coreSdkVersion: ${JSON.stringify(versionOf("@modelcontextprotocol/core"))},
  skillVersion: ${JSON.stringify(skillVersion)},
} as const;
`;
const outputPath = join(root, "src/generatedPackageMetadata.ts");
await ensureGeneratedFile({
  path: outputPath,
  source,
  check: arguments_.has("--check"),
  generateCommand: "npm run build",
});
await validateBuildCache(root);
