import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { ESP32C3_APP_SEGMENTS, espImage } from "../fixtures/espImage.js";
import { artifactInventorySummaryViewResultSchema } from "../../src/domain/analysisView/analysisViewResult.js";
import { artifactComparisonResultSchema } from "../../src/domain/artifactComparison.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import { parseEvidence, type Evidence } from "../../src/domain/evidence.js";
import { historicalInventoryEvidence } from "../fixtures/artifactEvidence.js";
import { connectArtifactComparisonMcp } from "../fixtures/artifactComparisonMcp.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it("reports an ESP segment whose load address alone changed", async () => {
  const root = await createTestTempDirectory("rea-esp-comparison-");
  const { inspect: inspectFile, compare } =
    await connectArtifactComparisonMcp();
  const inspect = async (
    name: string,
    segments: typeof ESP32C3_APP_SEGMENTS,
  ): Promise<Evidence> => {
    const path = join(root, name);
    await writeFile(path, espImage({ segments }));
    return inspectFile(path);
  };
  const segment = (evidence: Evidence, path: string) => {
    const occurrence = artifactInventoryResultSchema
      .parse(evidence.normalized_result)
      .occurrences.find(({ logical_path }) => logical_path === path);
    if (occurrence === undefined) throw new Error(`Missing ${path}`);
    return occurrence;
  };

  // The same bytes, with the DRAM segment loading 8 KiB higher.
  const moved = ESP32C3_APP_SEGMENTS.map((item, index) =>
    index === 1 ? { ...item, address: 0x3fc8_a000 } : item,
  );
  const left = await inspect("app.bin", ESP32C3_APP_SEGMENTS);
  const right = await inspect("moved.bin", moved);
  const leftSegment = segment(left, "segment-01.bin");
  const rightSegment = segment(right, "segment-01.bin");
  expect(rightSegment.artifact_id).toBe(leftSegment.artifact_id);
  expect(leftSegment.format_metadata).toMatchObject({ load_addr: 0x3fc8_8000 });
  expect(rightSegment.format_metadata).toMatchObject({
    load_addr: 0x3fc8_a000,
  });

  const changed = await compare(left, right);
  expect(
    changed.changes.filter(({ logical_path }) => logical_path !== "."),
  ).toEqual([
    {
      classification: "changed",
      logical_path: "segment-01.bin",
      dimensions: ["metadata"],
      left_occurrence_id: leftSegment.occurrence_id,
      right_occurrence_id: rightSegment.occurrence_id,
      left_artifact_id: leftSegment.artifact_id,
      right_artifact_id: rightSegment.artifact_id,
      evidence_links: [left.evidence_id, right.evidence_id],
    },
  ]);

  // Equal declarations leave every segment unchanged.
  const same = await compare(
    left,
    await inspect("copy.bin", ESP32C3_APP_SEGMENTS),
  );
  expect(same.changes).toEqual([]);
});

/** An ESP image inventory without `flash_dump`, as releases before 6.9 wrote it. */
const withoutFlashDump = (source: Evidence): Evidence => {
  return historicalInventoryEvidence(
    source,
    (occurrence) => {
      if (occurrence.format_metadata?.kind !== "esp-image") return occurrence;
      const { flash_dump: _dump, ...historical } = occurrence.format_metadata;
      // The current type requires the field this record omits.
      return {
        ...occurrence,
        format_metadata: historical as typeof occurrence.format_metadata,
      };
    },
    "observed",
  );
};

// Every ESP image root records `flash_dump` (null when the file is not a
// flash dump read from a later address), so an inventory without it is
// refused rather than read as one with unknown origin.
it("refuses ESP image inventory Evidence without flash_dump", async () => {
  const root = await createTestTempDirectory("rea-esp-historical-");
  const path = join(root, "app.bin");
  await writeFile(path, espImage({ segments: ESP32C3_APP_SEGMENTS }));
  const { call } = await connectLocalToolsMcp();
  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const inspected = await call("inspect_artifact", {});
  expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
  const current = parseEvidence(
    artifactInspectionResultSchema
      .parse(parseEvidence(inspected.structuredContent).normalized_result)
      .substeps.find(({ operation }) => operation === "inventory_artifact")
      ?.evidence,
  );
  const rootMetadata = artifactInventoryResultSchema
    .parse(current.normalized_result)
    .occurrences.find(
      ({ logical_path }) => logical_path === ".",
    )?.format_metadata;
  expect(rootMetadata).toMatchObject({ kind: "esp-image", flash_dump: null });

  const compared = await call("compare_artifacts", {
    left: withoutFlashDump(current),
    right: current,
  });
  expect(compared.isError).toBe(true);
  expect(JSON.stringify(compared.content)).toContain("flash_dump");
});
