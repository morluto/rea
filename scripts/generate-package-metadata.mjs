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
  join(root, "skills/reverse-engineer-anything/SKILL.md"),
  "utf8",
);
const skillVersion = /^\s{2}version:\s*"([^"]+)"\s*$/mu.exec(skill)?.[1];
if (skillVersion === undefined)
  throw new Error("Missing reverse-engineer-anything skill metadata version");
const versionOf = (name) => {
  const value = lock.packages?.[`node_modules/${name}`]?.version;
  if (typeof value !== "string")
    throw new Error(`Missing locked ${name} version`);
  return value;
};
const windowsNativeAuthority = packageJson.rea?.windowsNativeAuthority;
if (
  typeof windowsNativeAuthority?.packageName !== "string" ||
  !Number.isInteger(windowsNativeAuthority.contractVersion) ||
  !Number.isInteger(windowsNativeAuthority.nodeApiVersion) ||
  (windowsNativeAuthority.artifactSha256 !== null &&
    (typeof windowsNativeAuthority.artifactSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(windowsNativeAuthority.artifactSha256)))
)
  throw new Error("Invalid Windows native authority package metadata");
const source = `/** Generated from package.json and package-lock.json; do not edit. */
export const PACKAGE_METADATA = {
  name: ${JSON.stringify(packageJson.name)},
  version: ${JSON.stringify(packageJson.version)},
  serverSdkVersion: ${JSON.stringify(versionOf("@modelcontextprotocol/server"))},
  clientSdkVersion: ${JSON.stringify(versionOf("@modelcontextprotocol/client"))},
  coreSdkVersion: ${JSON.stringify(versionOf("@modelcontextprotocol/core"))},
  skillVersion: ${JSON.stringify(skillVersion)},
  windowsNativeAuthority: {
    packageName: ${JSON.stringify(windowsNativeAuthority.packageName)},
    packageVersion: ${JSON.stringify(packageJson.version)},
    contractVersion: ${JSON.stringify(windowsNativeAuthority.contractVersion)},
    nodeApiVersion: ${JSON.stringify(windowsNativeAuthority.nodeApiVersion)},
    artifactSha256: ${JSON.stringify(windowsNativeAuthority.artifactSha256)},
  },
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
