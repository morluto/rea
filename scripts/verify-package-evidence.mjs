import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createEvidence } from "../dist/domain/evidence.js";
import { json, run } from "./lib/verify-package-core.mjs";

/** Round-trip historical reference import and evidence bundles. */
export async function verifyPackageEvidence({
  cli,
  evidenceRoot,
  referenceRoot,
  environment,
}) {
  const referenceImport = json(
    await run(
      cli,
      ["import-reference-source", referenceRoot, "--json"],
      environment,
    ),
  );
  if (
    referenceImport.authority !== "historical-reference" ||
    referenceImport.root_alias !== "$REFERENCE_ROOT" ||
    referenceImport.relationships?.[0]?.resolution !== "internal" ||
    JSON.stringify(referenceImport).includes("PACKAGE_SECRET_SENTINEL")
  )
    throw new Error("packaged historical reference import CLI failed");
  const { createEvidenceBundle, serializeEvidenceBundle } = await import(
    new URL("../dist/domain/evidenceBundle.js", import.meta.url)
  );
  const sourceBundle = createEvidenceBundle([
    createEvidence(
      undefined,
      { id: "package", name: "Package verifier", version: "1" },
      { operation: "health", parameters: {}, result: true },
    ),
  ]);
  const sourceBundlePath = join(evidenceRoot, "source.json");
  const canonicalBundlePath = join(evidenceRoot, "canonical.json");
  await writeFile(sourceBundlePath, serializeEvidenceBundle(sourceBundle));
  const importedBundle = json(
    await run(
      cli,
      ["evidence-import", sourceBundlePath, "--json"],
      environment,
    ),
  );
  const exportedBundle = json(
    await run(
      cli,
      ["evidence-export", sourceBundlePath, canonicalBundlePath, "--json"],
      environment,
    ),
  );
  const comparedBundle = json(
    await run(
      cli,
      ["compare", sourceBundlePath, canonicalBundlePath, "--json"],
      environment,
    ),
  );
  if (
    importedBundle.imported !== 1 ||
    importedBundle.total !== 1 ||
    exportedBundle.records !== 1 ||
    (await readFile(canonicalBundlePath, "utf8")) !==
      serializeEvidenceBundle(sourceBundle) ||
    comparedBundle.status !== "unchanged" ||
    comparedBundle.summary?.records_unchanged !== 1
  )
    throw new Error(
      "packaged CLI evidence bundle comparison round trip failed",
    );
}
