import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateBuildCache } from "./build-cache.mjs";

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
let existingSource;
try {
  existingSource = await readFile(outputPath, "utf8");
} catch (cause) {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("code" in cause) ||
    cause.code !== "ENOENT"
  )
    throw cause;
}
if (existingSource !== source) await writeFile(outputPath, source, "utf8");
await validateBuildCache(root);
