import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import {
  INVESTIGATION_EXAMPLES,
  PROCESS_CAPTURE_REFERENCE,
  PROCESS_CAPTURE_RECONSTRUCTION,
  PROCESS_COMPARISON_EVIDENCE,
} from "../../../src/contracts/investigationExamples.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";
import { reconstructionVerificationResultSchema } from "../../../src/domain/reconstructionVerificationSchemas.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// Canonical synthetic process records exercise public adapters, not live capture.
const specification =
  INVESTIGATION_EXAMPLES.verify_reconstruction.specification;
const evidenceBundle = createEvidenceBundle([
  PROCESS_CAPTURE_REFERENCE,
  PROCESS_CAPTURE_RECONSTRUCTION,
  PROCESS_COMPARISON_EVIDENCE,
]);

cliTest(
  "CLI and MCP verify the same finite portable process specification",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-offline-verification-");
    const requestPath = join(root, "request.json");
    await writeFile(
      requestPath,
      JSON.stringify({ specification, evidence_bundle: evidenceBundle }),
    );
    const invocation = await cli.run({
      arguments: ["verify-reconstruction", requestPath, "--json"],
      environment: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
    expect(invocation.exitCode, invocation.stderr).toBe(0);
    const verified = reconstructionVerificationResultSchema.parse(
      invocation.json,
    );
    expect(verified).toMatchObject({
      status: "pass",
      summary: { passed: 1, failed: 0, unknown: 0 },
    });

    const mcp = await connectLocalToolsMcp();
    const comparisonResponse = await mcp.call("compare_process_captures", {
      left: PROCESS_CAPTURE_REFERENCE,
      right: PROCESS_CAPTURE_RECONSTRUCTION,
    });
    expect(
      comparisonResponse.isError,
      JSON.stringify(comparisonResponse),
    ).not.toBe(true);
    const comparison = parseEvidence(comparisonResponse.structuredContent);
    expect(comparison.evidence_id).toBe(
      PROCESS_COMPARISON_EVIDENCE.evidence_id,
    );
    const response = await mcp.call("verify_reconstruction", { specification });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(parseEvidence(response.structuredContent).normalized_result).toEqual(
      verified,
    );
  },
);

cliTest(
  "CLI verification preserves malformed input and missing source diagnostics",
  async ({ cli }) => {
    for (const request of [
      { specification },
      { specification, evidence_bundle: createEvidenceBundle([]) },
      { specification, evidence_bundle: evidenceBundle, unexpected: true },
    ]) {
      const response = await cli.run({
        arguments: ["verify-reconstruction", JSON.stringify(request), "--json"],
        environment: { ...process.env, REA_LOG_LEVEL: "silent" },
      });
      expect(response.exitCode, JSON.stringify(response.json)).toBe(1);
      expect(response.json).toMatchObject({ code: "invalid_request" });
    }
  },
);

cliTest(
  "CLI verification rejects a modified source record without resigning its identity",
  async ({ cli }) => {
    const bundle = {
      ...evidenceBundle,
      records: evidenceBundle.records.map((source) =>
        source.evidence_id === PROCESS_CAPTURE_REFERENCE.evidence_id
          ? {
              ...source,
              normalized_result: {
                ...jsonObjectSchema.parse(source.normalized_result),
                truncated: true,
              },
            }
          : source,
      ),
    };
    const response = await cli.run({
      arguments: [
        "verify-reconstruction",
        JSON.stringify({ specification, evidence_bundle: bundle }),
        "--json",
      ],
      environment: { ...process.env, REA_LOG_LEVEL: "silent" },
    });
    expect(response.exitCode, JSON.stringify(response.json)).toBe(1);
    expect(response.json).toMatchObject({
      code: "evidence_integrity_mismatch",
    });
  },
);
