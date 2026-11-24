import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { artifactInventoryResultSchema } from "../../src/domain/artifactGraph.js";
import type { Evidence } from "../../src/domain/evidence.js";
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
  const member = (evidence: Evidence, path: string) => {
    const occurrence = artifactInventoryResultSchema
      .parse(evidence.normalized_result)
      .occurrences.find(({ logical_path }) => logical_path === path);
    if (occurrence === undefined) throw new Error(`Missing ${path}`);
    return occurrence;
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
  expect(member(flagged, nfc).artifact_id).toBe(member(left, nfc).artifact_id);
  expect(member(left, nfc).format_metadata).toMatchObject({ flags: 4 });
  expect(member(flagged, nfc).format_metadata).toMatchObject({ flags: 0 });
  expect(await memberChanges(left, flagged)).toEqual([
    {
      classification: "changed",
      logical_path: nfc,
      dimensions: ["metadata"],
      left_occurrence_id: member(left, nfc).occurrence_id,
      right_occurrence_id: member(flagged, nfc).occurrence_id,
      left_artifact_id: member(left, nfc).artifact_id,
      right_artifact_id: member(flagged, nfc).artifact_id,
      evidence_links: [left.evidence_id, flagged.evidence_id],
    },
  ]);

  // A path stored decomposed pairs with its composed form, and the stored
  // spelling is the member's declared source path.
  const decomposed = await inspect("nfd.unity3d", [
    { ...serialized, path: "CAB-café" },
    resource,
  ]);
  expect(member(decomposed, nfc).format_metadata).toMatchObject({
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
  expect(member(reordered, nfc).format_metadata).toMatchObject({
    index: 1,
    declared_offset: Buffer.byteLength(resource.data),
  });
  expect(member(left, nfc).format_metadata).toMatchObject({
    index: 0,
    declared_offset: 0,
  });
  expect(await memberChanges(left, reordered)).toEqual([]);
});
