import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  appendAvbFooter,
  buildBootImage,
  osVersionRaw,
} from "../../fixtures/androidBootImage.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["full", "compact"] as const)(
  "retains Android boot image facts through compiled MCP (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-android-boot-mcp-");
    const path = join(root, "boot.img");
    const kernel = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    const ramdisk = Buffer.from([0x1f, 0x8b, 0x08, 0, 0x61]);
    const signature = Buffer.from("boot-signature");
    const image = buildBootImage({
      version: 4,
      kernel,
      ramdisk,
      signature,
      cmdline: "console=tty0",
      osVersion: osVersionRaw(13, 0, 0, 2024, 11),
    });
    const bytes = appendAvbFooter(image);
    await writeFile(path, bytes);
    const { call } = await connectLocalToolsMcp({
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
    });
    let outputRoot: string | undefined;
    try {
      const opened = await call("open_binary", { path });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      expect(opened.structuredContent).toMatchObject({
        result: {
          kind: "archive",
          format: "android-boot-image",
          architecture: null,
        },
      });
      const reply = await call("inspect_artifact", {});
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const inspection = artifactInspectionResultSchema.parse(
        parseEvidence(reply.structuredContent).normalized_result,
      );
      const inventory = inspection.substeps[0]!.evidence.normalized_result;
      expect(inventory.coverage.status).toBe("complete");
      expect(inventory.occurrences).toContainEqual(
        expect.objectContaining({
          logical_path: ".",
          format_metadata: expect.objectContaining({
            kind: "android-boot-image",
            header_version: 4,
            os_version: "13.0.0",
            security_patch_level: "2024-11",
            command_line: "console=tty0",
            signature_size: signature.length,
            avb_footer_present: true,
            avb_footer_size: 64,
          }),
        }),
      );
      expect(inventory.occurrences).toContainEqual(
        expect.objectContaining({
          logical_path: "ramdisk",
          format_metadata: expect.objectContaining({ compression: "gzip" }),
          source_location: { offset: 8192, length: ramdisk.length },
        }),
      );
      expect(inventory.occurrences).toContainEqual(
        expect.objectContaining({
          logical_path: "signature",
          source_location: { offset: 12288, length: signature.length },
        }),
      );
      expect(inventory.nodes).toContainEqual(
        expect.objectContaining({
          sha256: createHash("sha256").update(ramdisk).digest("hex"),
        }),
      );
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
      expect((await readFile(join(outputRoot, "kernel"))).equals(kernel)).toBe(
        true,
      );
      expect(
        (await readFile(join(outputRoot, "ramdisk"))).equals(ramdisk),
      ).toBe(true);
      expect(
        (await readFile(join(outputRoot, "signature"))).equals(signature),
      ).toBe(true);
      expect((await readFile(path)).equals(bytes)).toBe(true);
      await call("close_binary", {});
    } finally {
      if (outputRoot !== undefined)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
  60_000,
);
