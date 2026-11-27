import { createHash } from "node:crypto";
import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";

import { artifactExtractionResultSchema } from "../../../src/domain/artifactGraph.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { advertisedMcpToolSchemas } from "../../fixtures/advertisedMcpTool.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createSignedAfterPackingAsarAddon } from "../../fixtures/signedAfterPackingAsarAddon.js";
import { createStrippedAsarAddon } from "../../fixtures/strippedAsarAddon.js";
import { openArtifactTarget } from "../../support/mcp/artifactSession.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

mcpTest(
  "publishes signed companion evidence through the advertised JavaScript analysis schema",
  async ({ mcp }) => {
    const { archive, addon, declaredSha256 } =
      await createSignedAfterPackingAsarAddon();
    const client = await openArtifactTarget(mcp, onTestFinished, archive);
    const schemas = await advertisedMcpToolSchemas(
      client,
      "analyze_javascript_application",
    );
    const response = await client.callTool({
      name: "analyze_javascript_application",
      arguments: {
        input_path: archive,
        integrity_policy: "record-and-continue",
      },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(
      schemas.ajv.validate(schemas.outputSchema, response.structuredContent),
      JSON.stringify(schemas.ajv.errors),
    ).toBe(true);
    expect(response.structuredContent).toMatchObject({
      normalized_result: {
        integrity_contradictions: expect.arrayContaining([
          expect.objectContaining({
            logical_path: addon,
            signing_explanation: expect.objectContaining({
              kind: "signed-after-packing",
              platform: "pe-authenticode",
              unsigned_sha256: declaredSha256,
              signer_subjects: [
                expect.stringContaining("commonName=REA Fixture"),
              ],
              signer_subjects_complete: true,
            }),
          }),
        ]),
      },
    });
  },
);

mcpTest(
  "distinguishes rewritten and missing companions across extraction retries",
  async ({ mcp }) => {
    const { root, archive, addon, original, stripped } =
      await createStrippedAsarAddon();
    const client = await openArtifactTarget(mcp, onTestFinished, archive);
    const output = join(root, "output");
    const declared = createHash("sha256").update(original).digest("hex");
    const observed = createHash("sha256").update(stripped).digest("hex");
    const strict = await client.callTool({
      name: "extract_artifact",
      arguments: { output_root: output },
    });
    expect(parseMcpToolError(strict).error).toMatchObject({
      code: "artifact_integrity_mismatch",
      message: expect.stringContaining("integrity_policy=record-and-continue"),
      details: {
        logical_path: addon,
        unpacked: true,
        declared_sha256: declared,
        calculated_sha256: observed,
      },
    });
    await expect(lstat(output)).rejects.toMatchObject({ code: "ENOENT" });

    const continued = await client.callTool({
      name: "extract_artifact",
      arguments: {
        output_root: output,
        integrity_policy: "record-and-continue",
      },
    });
    expect(continued.isError, JSON.stringify(continued)).not.toBe(true);
    const evidence = parseEvidence(continued.structuredContent);
    expect(evidence.parameters).toMatchObject({
      integrity_policy: "record-and-continue",
    });
    const result = artifactExtractionResultSchema.parse(
      evidence.normalized_result,
    );
    expect(result.output_root).toBe(output);
    expect((await readFile(join(output, addon))).equals(stripped)).toBe(true);
    expect(result.integrity_contradictions).toMatchObject([
      {
        logical_path: addon,
        trust: "observed-untrusted",
        declared_sha256: declared,
        observed_sha256: observed,
      },
    ]);

    await rm(join(`${archive}.unpacked`, addon));
    const missingOutput = join(root, "missing-output");
    const missing = await client.callTool({
      name: "extract_artifact",
      arguments: { output_root: missingOutput },
    });
    expect(parseMcpToolError(missing).error).toMatchObject({
      code: "artifact_operation_failed",
      category: "unavailable",
      message: expect.stringContaining(".unpacked"),
      details: { logical_path: addon, unpacked: true },
    });
    await expect(lstat(missingOutput)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
