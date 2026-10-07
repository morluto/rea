import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect } from "vitest";

import { runProviderAnalysis } from "../../src/composition/directAnalysis.js";
import type { AnalysisError } from "../../src/domain/analysisErrorBase.js";
import { type Evidence, parseEvidence } from "../../src/domain/evidence.js";
import type { Result } from "../../src/domain/result.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

/** Assert a projection succeeded and return its Evidence for schema parsing. */
export const requireSuccessfulProjection = (
  result: Result<Evidence, AnalysisError>,
): Evidence => {
  expect(result.ok).toBe(true);
  if (!result.ok)
    throw new TypeError("Expected application projection to succeed");
  return result.value;
};

/**
 * Build inventory Evidence from a ZIP that is neither an APK nor an IPA.
 * Both mobile projections must reject it with an AnalysisInputError.
 */
export const createNonApplicationZipInventory = async (
  prefix: string,
): Promise<Evidence> => {
  const root = await createTestTempDirectory(prefix);
  const path = join(root, "fixture.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add("one.js", new TextReader("one"));
  await writeFile(path, await writer.close());
  return parseEvidence(
    await runProviderAnalysis(path, "inventory_artifact", {}),
  );
};
