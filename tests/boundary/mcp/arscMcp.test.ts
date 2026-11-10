import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { artifactInspectionResultSchema } from "../../../src/domain/artifactInspection.js";
import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import {
  ARSC_BASIC_TYPES,
  ARSC_BASIC_VALUES,
  buildArsc,
} from "../../fixtures/arsc.js";

it.each(["full", "compact"] as const)(
  "decodes arsc facts and XML text through compiled MCP (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-arsc-mcp-");
    const path = join(root, "resources.arsc");
    await writeFile(
      path,
      buildArsc({ types: ARSC_BASIC_TYPES, values: ARSC_BASIC_VALUES }),
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
        expect.objectContaining({ logical_path: "resources.xml" }),
      );
      const extracted = await call("extract_artifact", {});
      expect(extracted.isError, JSON.stringify(extracted)).not.toBe(true);
      const result = artifactExtractionResultSchema.parse(
        parseEvidence(extracted.structuredContent).normalized_result,
      );
      outputRoot = result.output_root;
      const xml = await readFile(join(outputRoot, "resources.xml"), "utf8");
      expect(xml).toContain('name="com.example.app"');
      expect(xml).toContain('name="app_name" value="Fanqie Novel"');
    } finally {
      if (outputRoot !== undefined)
        await rm(outputRoot, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);
