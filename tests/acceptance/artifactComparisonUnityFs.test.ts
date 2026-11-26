import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import type { Evidence } from "../../src/domain/evidence.js";
import { occurrenceAt } from "../fixtures/artifactEvidence.js";
import { connectArtifactComparisonMcp } from "../fixtures/artifactComparisonMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { buildUnityFs, type UnityFsMember } from "../fixtures/unityfs.js";

it("compares UnityFS member declarations without their layout", async () => {
  const root = await createTestTempDirectory("rea-unityfs-comparison-");
  const { inspect: inspectFile, compare } =
    await connectArtifactComparisonMcp();
  const inspect = async (
    name: string,
    members: readonly UnityFsMember[],
  ): Promise<Evidence> => {
    const path = join(root, name);
    await writeFile(path, buildUnityFs(members));
    return inspectFile(path);
  };

  const memberChanges = async (left: Evidence, right: Evidence) =>
    (await compare(left, right)).changes.filter(
      ({ logical_path }) => logical_path !== ".",
    );

  const nfc = "CAB-café";
  const serialized = { path: nfc, data: "serialized file bytes", flags: 4 };
  const resource = { path: "CAB-cafe.resS", data: "resource bytes" };
  const left = await inspect("left.unity3d", [serialized, resource]);

  // The same bytes with other raw node flags.
  const flagged = await inspect("flags.unity3d", [
    { ...serialized, flags: 0 },
    resource,
  ]);
  expect(occurrenceAt(flagged, nfc).artifact_id).toBe(
    occurrenceAt(left, nfc).artifact_id,
  );
  expect(occurrenceAt(left, nfc).format_metadata).toMatchObject({
    flags: 4,
  });
  expect(occurrenceAt(flagged, nfc).format_metadata).toMatchObject({
    flags: 0,
  });
  expect(await memberChanges(left, flagged)).toEqual([
    {
      classification: "changed",
      logical_path: nfc,
      dimensions: ["metadata"],
      left_occurrence_id: occurrenceAt(left, nfc).occurrence_id,
      right_occurrence_id: occurrenceAt(flagged, nfc).occurrence_id,
      left_artifact_id: occurrenceAt(left, nfc).artifact_id,
      right_artifact_id: occurrenceAt(flagged, nfc).artifact_id,
      evidence_links: [left.evidence_id, flagged.evidence_id],
    },
  ]);

  // A path stored decomposed pairs with its composed form, and the stored
  // spelling is the member's declared source path.
  const decomposed = await inspect("nfd.unity3d", [
    { ...serialized, path: "CAB-café" },
    resource,
  ]);
  expect(occurrenceAt(decomposed, nfc).format_metadata).toMatchObject({
    source_path: "CAB-café",
  });
  expect(await memberChanges(left, decomposed)).toEqual([
    expect.objectContaining({
      classification: "changed",
      logical_path: nfc,
      dimensions: ["metadata"],
    }),
  ]);

  // Directory order and stream offsets are layout.
  const reordered = await inspect("reordered.unity3d", [resource, serialized]);
  expect(occurrenceAt(reordered, nfc).format_metadata).toMatchObject({
    index: 1,
    declared_offset: Buffer.byteLength(resource.data),
  });
  expect(occurrenceAt(left, nfc).format_metadata).toMatchObject({
    index: 0,
    declared_offset: 0,
  });
  expect(await memberChanges(left, reordered)).toEqual([]);
});
