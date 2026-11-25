import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { buildIso9660Image } from "../../../src/domain/iso9660/iso9660.fixture.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it("retains ISO 9660 volume and entry facts through compiled MCP", async () => {
  const root = await createTestTempDirectory("rea-iso9660-mcp-");
  const path = join(root, "media.iso");
  const payload = Buffer.from("payload-bytes");
  const units = Buffer.from("interleaved-bytes");
  const { bytes, layout } = buildIso9660Image({
    joliet: true,
    files: [
      { path: "data/payload.bin", bytes: payload },
      { path: "units.bin", bytes: units, interleaved: true },
    ],
  });
  await writeFile(path, bytes);
  const { call } = await connectLocalToolsMcp({
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  });
  let outputRoot: string | undefined;
  try {
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    expect(opened.structuredContent).toMatchObject({
      result: { kind: "archive", format: "iso9660", architecture: null },
    });
    const reply = await call("inspect_artifact", {});
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(reply.structuredContent).normalized_result,
    );
    const inventory = inspection.substeps[0]!.evidence.normalized_result;
    // Joliet names are walked; the primary tree is not, so coverage is open.
    expect(inventory.coverage.status).toBe("unknown");
    expect(inventory.occurrences).toContainEqual(
      expect.objectContaining({
        logical_path: "data/payload.bin",
        source_location: {
          offset: layout.fileOffsets.get("data/payload.bin"),
          length: payload.length,
        },
        format_metadata: expect.objectContaining({
          kind: "iso9660-entry",
          identifier: "payload.bin;1",
          extent_layout: "contiguous",
        }),
      }),
    );
    expect(inventory.occurrences).toContainEqual(
      expect.objectContaining({
        logical_path: "units.bin",
        hash_status: "unavailable",
        format_metadata: expect.objectContaining({
          extent_layout: "interleaved",
        }),
      }),
    );
    expect(inventory.nodes).toContainEqual(
      expect.objectContaining({
        sha256: createHash("sha256").update(payload).digest("hex"),
      }),
    );
    // A whole-image extraction cannot materialize the interleaved file.
    const { error } = parseMcpToolError(await call("extract_artifact", {}));
    expect(error).toMatchObject({
      details: { operation: "extract_artifact", reason: "unavailable" },
    });
    const payloadOccurrence = inventory.occurrences.find(
      (row: { logical_path: string }) =>
        row.logical_path === "data/payload.bin",
    )!;
    const extracted = await call("extract_artifact", {
      occurrence_ids: [payloadOccurrence.occurrence_id],
    });
    expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.structuredContent).normalized_result,
    );
    outputRoot = result.output_root;
    expect(result.containment_verified).toBe(true);
    expect(
      (await readFile(join(outputRoot, "data/payload.bin"))).equals(payload),
    ).toBe(true);
    expect((await readFile(path)).equals(bytes)).toBe(true);
    await call("close_binary", {});
  } finally {
    if (outputRoot !== undefined)
      await rm(outputRoot, { recursive: true, force: true });
  }
});

it("opens ISO 9660 content named like a Hopper database as an archive", async () => {
  const root = await createTestTempDirectory("rea-iso9660-mcp-hop-");
  const path = join(root, "installer.hop");
  await writeFile(
    path,
    buildIso9660Image({
      files: [{ path: "README.TXT", bytes: Buffer.from("readme") }],
    }).bytes,
  );
  const { call } = await connectLocalToolsMcp({
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
  });
  const opened = await call("open_binary", { path });
  expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
  expect(opened.structuredContent).toMatchObject({
    result: { kind: "archive", format: "iso9660" },
  });
  const reply = await call("inspect_artifact", {});
  expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
  const inspection = artifactInspectionResultSchema.parse(
    parseEvidence(reply.structuredContent).normalized_result,
  );
  expect(
    inspection.substeps[0]!.evidence.normalized_result.occurrences,
  ).toContainEqual(expect.objectContaining({ logical_path: "README.TXT" }));
  await call("close_binary", {});
});
