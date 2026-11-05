import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { buildAnp3, buildImgV2 } from "../../fixtures/imgAnp3.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  artifactExtractionResultSchema,
  artifactInventoryResultSchema,
} from "../../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";

const SECTOR_BYTES = 2048;

const packageBytes = (): Buffer =>
  buildAnp3("actor", [
    {
      name: "walk_civi",
      objects: [
        { bone: "Root", boneId: 0, frameType: 4, times: [0, 0.5, 1.25] },
        { bone: "Pelvis", boneId: 1, frameType: 3, times: [0, 1] },
      ],
    },
    {
      name: "idle stance",
      objects: [{ bone: "Root", boneId: 0, frameType: 2, times: [0, 2.5] }],
    },
  ]);

const inspect = async (
  call: Awaited<ReturnType<typeof connectLocalToolsMcp>>["call"],
) => {
  const reply = await call("inspect_artifact", {});
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const inspection = artifactInspectionResultSchema.parse(
    parseEvidence(reply.structuredContent).normalized_result,
  );
  return {
    inspection,
    inventory: artifactInventoryResultSchema.parse(
      inspection.substeps[0]?.evidence.normalized_result,
    ),
  };
};

it("inventories an IMG archive, extracts its ANP3 member and lists that package's animations through MCP", async () => {
  const root = await createTestTempDirectory("rea-img-anp3-mcp-");
  const anp3 = packageBytes();
  const padded = Buffer.alloc(
    Math.ceil(anp3.length / SECTOR_BYTES) * SECTOR_BYTES,
  );
  anp3.copy(padded);
  const path = join(root, "anim.img");
  await writeFile(
    path,
    buildImgV2([
      { name: "actor.bin", data: anp3 },
      { name: "notes.dat", data: Buffer.from("notes"), sizeField: "archive" },
    ]),
  );
  const { call } = await connectLocalToolsMcp({});
  let outputRoot: string | undefined;
  try {
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const archive = await inspect(call);
    expect(archive.inventory.manifest.root_format).toBe("img-v2");
    expect(
      archive.inventory.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toEqual({
      kind: "img-v2",
      version: 2,
      entry_count: 2,
      sector_bytes: SECTOR_BYTES,
      directory_end: 72,
    });
    const member = archive.inventory.occurrences.find(
      (row) => row.logical_path === "actor.bin",
    );
    expect(member).toMatchObject({
      artifact_format: "anp3",
      declared_size: padded.length,
      hash_status: "verified",
      format_metadata: {
        kind: "img-v2-entry",
        index: 0,
        name: "actor.bin",
        offset_sectors: 1,
        streaming_sectors: 1,
        archive_sectors: 0,
      },
    });
    expect(archive.inventory.nodes).toContainEqual(
      expect.objectContaining({
        sha256: createHash("sha256").update(padded).digest("hex"),
      }),
    );
    expect(archive.inspection.next_probes).toContainEqual(
      expect.objectContaining({ operation: "extract_artifact" }),
    );

    const extracted = await call("extract_artifact", {});
    expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.structuredContent).normalized_result,
    );
    outputRoot = result.output_root;
    expect(result.containment_verified).toBe(true);
    const memberPath = join(result.output_root, "actor.bin");
    expect((await readFile(memberPath)).equals(padded)).toBe(true);
    await call("close_binary", {});

    const reopened = await call("open_binary", { path: memberPath });
    expect(reopened.isError, JSON.stringify(reopened)).not.toBe(true);
    const animations = await inspect(call);
    expect(animations.inventory.manifest.root_format).toBe("anp3");
    expect(
      animations.inventory.occurrences.find((row) => row.logical_path === ".")
        ?.format_metadata,
    ).toMatchObject({
      kind: "anp3",
      signature: "ANP3",
      package_name: "actor",
      animation_count: 2,
      trailing_bytes: padded.length - anp3.length,
    });
    expect(
      animations.inventory.occurrences
        .filter((row) => row.format_metadata?.kind === "anp3-animation")
        .map(({ logical_path, format_metadata }) => ({
          logical_path,
          format_metadata,
        })),
    ).toEqual([
      {
        logical_path: "animations/0000-walk_civi.bin",
        format_metadata: expect.objectContaining({
          name: "walk_civi",
          object_count: 2,
          keyframe_count: 5,
          duration_seconds: 1.25,
          bones: [
            { name: "Root", bone_id: 0, frame_type: 4, frame_count: 3 },
            { name: "Pelvis", bone_id: 1, frame_type: 3, frame_count: 2 },
          ],
        }),
      },
      {
        logical_path: "animations/0001-idle_stance.bin",
        format_metadata: expect.objectContaining({
          name: "idle stance",
          object_count: 1,
          duration_seconds: 2.5,
        }),
      },
    ]);
    await call("close_binary", {});
  } finally {
    if (outputRoot !== undefined)
      await rm(outputRoot, { recursive: true, force: true });
  }
});

it("refuses an IMG member that leaves the archive through MCP", async () => {
  const root = await createTestTempDirectory("rea-img-anp3-malformed-mcp-");
  const path = join(root, "broken.img");
  const archive = buildImgV2([{ name: "actor.bin", data: packageBytes() }]);
  archive.writeUInt16LE(99, 12);
  await writeFile(path, archive);
  const { call } = await connectLocalToolsMcp({});
  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  const rejected = parseMcpToolError(await call("inspect_artifact", {}));
  expect(JSON.stringify(rejected.error)).toContain("beyond the");
  await call("close_binary", {});
});
