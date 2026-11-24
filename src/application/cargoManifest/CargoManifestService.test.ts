import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { ArtifactResourceScope } from "../../resources/ArtifactResourceScope.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { CARGO_MANIFEST_MAX_FILE_BYTES } from "../../domain/cargoManifest/cargoManifest.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { inspectCargoManifestEvidence } from "./CargoManifestService.js";

const MANIFEST = `[package]
name = "demo"
version = "0.1.0"
`;

const manifestFile = async (text = MANIFEST) => {
  const root = await createTestTempDirectory("rea-cargo-manifest-");
  const path = join(root, "Cargo.toml");
  await writeFile(path, text);
  return path;
};

const refusal = <T>(
  result: { ok: true; value: T } | { ok: false; error: AnalysisError },
) => {
  if (result.ok) throw new Error("Expected a refusal");
  const { error } = result;
  if (!(error instanceof AnalysisResourceConstraintError)) throw error;
  return error;
};

it("reports the caller's own file-size budget rather than the release maximum", async () => {
  const path = await manifestFile(`${MANIFEST}# ${"x".repeat(4096)}\n`);
  const resources = new ArtifactResourceScope();
  try {
    const error = refusal(
      await inspectCargoManifestEvidence(
        { path, max_file_bytes: 1024 },
        resources,
      ),
    );
    expect(error.resource).toBe("file-size");
    expect(error.reportedLimits).toMatchObject({ max_file_bytes: 1024 });
    expect(error.fixedAllowance).toBeUndefined();
    expect(error.remediationAction).toContain(
      "Raise max_file_bytes above 1024",
    );
  } finally {
    await resources.close();
  }
});

it("reports the release maximum as a fixed ceiling when that is what refused the file", async () => {
  // A caller that omits max_file_bytes selects the release maximum, so an
  // oversized manifest is refused at that ceiling and must not be reported as
  // a budget the caller can raise.
  const file = await manifestFile();
  const path = `${file}.large`;
  const handle = await open(path, "w");
  await handle.truncate(CARGO_MANIFEST_MAX_FILE_BYTES + 1);
  await handle.close();
  const resources = new ArtifactResourceScope();
  try {
    const error = refusal(
      await inspectCargoManifestEvidence({ path }, resources),
    );
    expect(error.resource).toBe("file-size");
    expect(error.fixedAllowance).toMatchObject({
      name: "The Cargo manifest input allowance",
      limit: CARGO_MANIFEST_MAX_FILE_BYTES,
      unit: "bytes",
    });
  } finally {
    await resources.close();
  }
});

it("records only the parameters the caller selected in Evidence", async () => {
  const path = await manifestFile();
  const resources = new ArtifactResourceScope();
  try {
    const selected = await inspectCargoManifestEvidence({ path }, resources);
    const explicit = await inspectCargoManifestEvidence(
      { path, max_file_bytes: CARGO_MANIFEST_MAX_FILE_BYTES },
      resources,
    );
    if (!selected.ok) throw selected.error;
    if (!explicit.ok) throw explicit.error;
    expect(selected.value.evidence.parameters).toEqual({ path });
    expect(explicit.value.evidence.parameters).toEqual({
      path,
      max_file_bytes: CARGO_MANIFEST_MAX_FILE_BYTES,
    });
  } finally {
    await resources.close();
  }
});
