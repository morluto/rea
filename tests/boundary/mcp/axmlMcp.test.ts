import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { AXML_MANIFEST_EVENTS, buildAxml } from "../../fixtures/axml.js";

it.each(["full", "compact"] as const)(
  "decodes axml facts and XML text through compiled MCP (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-axml-mcp-");
    const path = join(root, "AndroidManifest.xml");
    await writeFile(path, buildAxml(AXML_MANIFEST_EVENTS));
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
        expect.objectContaining({ logical_path: "document.xml" }),
      );
      const extracted = await call("extract_artifact", {});
      expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
      const result = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.structuredContent).normalized_result,
      );
      outputRoot = result.output_root;
      const xml = await readFile(join(outputRoot, "document.xml"), "utf8");
      expect(xml).toContain('package="com.example.app"');
      expect(xml).toContain('android:versionCode="3"');
      await call("close_binary", {});
    } finally {
      if (outputRoot !== undefined)
        await rm(outputRoot, { recursive: true, force: true });
    }
  },
);
