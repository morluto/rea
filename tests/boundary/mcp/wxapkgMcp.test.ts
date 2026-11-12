import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { buildWxapkg, wxapkgEncryptedBytes } from "../../fixtures/wxapkg.js";

it.each(["full", "compact"] as const)(
  "retains wxapkg facts and encrypted coverage through compiled MCP (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-wxapkg-mcp-");
    const path = join(root, "package.wxapkg");
    const payload = Buffer.from("module.exports={};");
    await writeFile(
      path,
      buildWxapkg([
        { path: "app-config.json", data: "{}" },
        { path: "pages/index/index.js", data: payload },
      ]),
    );
    const { call } = await connectLocalToolsMcp({
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
    });
    let outputRoot: string | undefined;
    try {
      expect((await call("open_binary", { path })).isError).not.toBe(true);
      const reply = await call("inspect_artifact", {});
      expect(reply.isError, JSON.stringify(reply)).not.toBe(true);
      const inspection = artifactInspectionResultSchema.parse(
        parseEvidence(reply.structuredContent).normalized_result,
      );
      const observed = inspection.substeps[0]!.evidence.normalized_result;
      expect(observed.occurrences).toContainEqual(
        expect.objectContaining({
          logical_path: "pages/index/index.js",
          hash_status: "verified",
          source_location: expect.objectContaining({
            offset: expect.any(Number),
          }),
        }),
      );
      const extracted = await call("extract_artifact", {});
      expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
      const result = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.structuredContent).normalized_result,
      );
      outputRoot = result.output_root;
      expect(
        (await readFile(join(outputRoot, "pages/index/index.js"))).equals(
          payload,
        ),
      ).toBe(true);
      await call("close_binary", {});
      // Encrypted PC-client packages remain represented without member guesses.
      await writeFile(path, wxapkgEncryptedBytes());
      await call("open_binary", { path });
      const unknownReply = await call("inspect_artifact", {});
      expect(unknownReply.isError, JSON.stringify(unknownReply)).not.toBe(true);
      const unknown = artifactInspectionResultSchema.parse(
        parseEvidence(unknownReply.structuredContent).normalized_result,
      ).substeps[0]!.evidence.normalized_result;
      expect(unknown.coverage).toMatchObject({ status: "unknown" });
      expect(unknown.occurrences).toMatchObject([
        {
          artifact_format: "wxapkg",
          encrypted: true,
          format_metadata: {
            kind: "wxapkg",
            directory_status: "encrypted",
            file_count: null,
          },
        },
      ]);
      const refused = await call("extract_artifact", {});
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused)).toContain("cannot be extracted");
      await call("close_binary", {});
    } finally {
      if (outputRoot !== undefined)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
  60_000,
);
