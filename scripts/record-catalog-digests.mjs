import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Record built-in catalog profile digests into the compiled runtime. Run after
// `tsc` and before bundling, so the digests come from the same compiled
// contracts and pinned schema converter that the runtime serves.
const compiledRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../dist",
);
const { createCatalogDigestProfiles, DEFAULT_CATALOG_IDENTITY } = await import(
  pathToFileURL(join(compiledRoot, "contracts/catalog/catalogIdentity.js")).href
);
// Retain only hashes, with every shared record frozen. Schemas remain owned by
// the compiled contracts and are converted once for both identities.
const digestProfiles = createCatalogDigestProfiles();
const profiles = Object.entries(digestProfiles)
  .map(
    ([output, digests]) =>
      `${JSON.stringify(output)}: Object.freeze(${JSON.stringify(digests)})`,
  )
  .join(",");
const defaultCounts = JSON.stringify(DEFAULT_CATALOG_IDENTITY.counts);
const defaultDigests = JSON.stringify(digestProfiles.off);
await writeFile(
  join(compiledRoot, "contracts/catalog/recordedCatalogDigests.js"),
  `/** Recorded from compiled catalog profiles by scripts/record-catalog-digests.mjs; do not edit. */\nexport const RECORDED_CATALOG_DIGEST_PROFILES = Object.freeze({${profiles}});\nexport const RECORDED_DEFAULT_CATALOG_IDENTITY = Object.freeze({ counts: Object.freeze(${defaultCounts}), digests: Object.freeze(${defaultDigests}) });\n`,
  "utf8",
);
