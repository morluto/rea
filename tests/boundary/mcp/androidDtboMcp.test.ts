import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ANDROID_DTBO_MAGIC } from "../../../src/domain/firmware/androidDtboFormat.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  sampleAndroidDtboV0,
  sampleAndroidDtboV1Mixed,
} from "../../fixtures/androidDtbo.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("inventories and extracts an Android DTBO image through compiled MCP", async () => {
  const root = await createTestTempDirectory("rea-android-dtbo-mcp-");
  const path = join(root, "dtbo.img");
  const fixture = sampleAndroidDtboV0();
  await writeFile(path, fixture.image);

  const { call } = await connectLocalToolsMcp({
    REA_MCP_TOOL_FAMILIES: "session,artifact",
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
    REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
  });

  let outputRoot: string | undefined;
  try {
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    expect(opened.structuredContent).toMatchObject({
      result: { kind: "archive", format: "android-dtbo", architecture: null },
    });

    const limited = await call("inspect_artifact", {
      artifact_limits: { android_dtbo: { entry_count: 1 } },
    });
    expect(limited.isError).toBe(true);
    expect(JSON.stringify(limited)).toContain(
      "artifact_limits.android_dtbo.entry_count",
    );

    const reply = await call("inspect_artifact", {
      artifact_limits: { android_dtbo: { entry_count: 2 } },
    });
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(reply.structuredContent).normalized_result,
    );
    const inventory = inspection.substeps[0]!.evidence.normalized_result;
    expect(inventory.effective_limits?.android_dtbo?.entry_count).toBe(2);
    expect(inventory.coverage.status).toBe("complete");
    expect(inventory.occurrences).toContainEqual(
      expect.objectContaining({
        logical_path: ".",
        format_metadata: expect.objectContaining({
          kind: "android-dtbo",
          magic: ANDROID_DTBO_MAGIC,
          dt_entry_count: 2,
          version: 0,
          emitted_entry_count: 2,
        }),
      }),
    );
    expect(inventory.occurrences).toContainEqual(
      expect.objectContaining({
        logical_path: "dtbo-0.dtbo",
        format_metadata: expect.objectContaining({
          kind: "android-dtbo-entry",
          index: 0,
          id: 0x00000101,
          rev: 0x00010000,
          fdt_magic_valid: true,
        }),
      }),
    );
    for (const blob of fixture.entries) {
      expect(inventory.nodes).toContainEqual(
        expect.objectContaining({
          sha256: createHash("sha256").update(blob).digest("hex"),
        }),
      );
    }
    expect(inspection.next_probes.map((p) => p.operation)).toEqual([
      "extract_artifact",
      "inspect_devicetree",
    ]);

    const extracted = await call("extract_artifact", {});
    expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
    const result = artifactExtractionResultSchema.parse(
      parseEvidence(extracted.structuredContent).normalized_result,
    );
    outputRoot = result.output_root;
    expect(result.containment_verified).toBe(true);
    expect(result.cleanup).toMatchObject({
      verified: true,
      residual_paths: [],
    });

    for (const [index, blob] of fixture.entries.entries()) {
      expect(
        (await readFile(join(outputRoot, `dtbo-${String(index)}.dtbo`))).equals(
          blob,
        ),
      ).toBe(true);
    }

    await call("close_binary", {});
  } finally {
    if (outputRoot !== undefined) {
      await rm(outputRoot, { recursive: true, force: true });
    }
  }
});

it("reports explicit compression and FDT-magic limitations for v1 DTBO entries via MCP", async () => {
  const root = await createTestTempDirectory("rea-android-dtbo-v1-mcp-");
  const path = join(root, "dtbo-v1.img");
  const mixed = sampleAndroidDtboV1Mixed();
  await writeFile(path, mixed.image);

  const { call } = await connectLocalToolsMcp({
    REA_MCP_TOOL_FAMILIES: "session,artifact",
    REA_MCP_INPUT_SCHEMA_PROFILE: "compact",
    REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
  });

  try {
    const opened = await call("open_binary", { path });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const reply = await call("inspect_artifact", {});
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
    const inspection = artifactInspectionResultSchema.parse(
      parseEvidence(reply.structuredContent).normalized_result,
    );
    const inventory = inspection.substeps[0]!.evidence.normalized_result;
    expect(inventory.occurrences).toContainEqual(
      expect.objectContaining({
        logical_path: "dtbo-1.dtbo",
        format_metadata: expect.objectContaining({
          kind: "android-dtbo-entry",
          compression: "gzip",
          flags: 2,
          fdt_magic_valid: null,
        }),
      }),
    );
    expect(
      inventory.limitations.some((line) => line.includes("gzip compression")),
    ).toBe(true);
  } finally {
    await call("close_binary", {});
  }
});
