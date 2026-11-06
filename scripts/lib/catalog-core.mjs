import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import canonicalize from "canonicalize";

const load = (root, path) => import(pathToFileURL(join(root, path)).href);

/** Sort tool/provider names alphabetically. */
export const names = (contracts) =>
  contracts
    .map(({ name }) => name)
    .sort((left, right) => left.localeCompare(right));

/** Return the stable digest for a generated catalog projection. */
export const digest = (value) => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Catalog projection is not canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};

/** Throw when two name lists diverge. */
export const assertSameNames = (label, actual, expected) => {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = [...expectedSet].filter((name) => !actualSet.has(name));
  const extra = [...actualSet].filter((name) => !expectedSet.has(name));
  if (missing.length === 0 && extra.length === 0) return;
  throw new Error(
    `${label} drifted (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
  );
};

const SOURCE_PATHS = {
  packageMetadata: "dist/generatedPackageMetadata.js",
  catalogIdentity: "dist/catalogIdentity.js",
  cliCommandNames: "dist/cliCommandNames.js",
  cli: "dist/cli.js",
  toolContracts: "dist/contracts/toolContracts.js",
  toolFamilies: "dist/contracts/toolFamilies.js",
  capabilityDeclarations: "dist/composition/capabilityDeclarations.js",
  supportedClients: "dist/application/SupportedClients.js",
};

/** Load every compiled source module referenced by the catalog. */
export const loadSources = async (root) =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(SOURCE_PATHS).map(async ([key, path]) => [
        key,
        await load(root, path),
      ]),
    ),
  );
