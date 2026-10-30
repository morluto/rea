import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { ESP32C3_APP_SEGMENTS, espImage } from "../fixtures/espImage.js";
import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import type { Evidence } from "../../src/domain/evidence.js";
import { connectArtifactComparisonMcp } from "../fixtures/artifactComparisonMcp.js";
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
