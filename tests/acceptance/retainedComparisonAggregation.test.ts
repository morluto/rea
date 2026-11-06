import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { FUNCTION_COMPARISON_EXAMPLE } from "../../src/contracts/functionComparisonExample.js";
import { FUNCTION_COMPARISON_EVIDENCE } from "../../src/contracts/investigationExamples.js";
import { changedBehaviorResultSchema } from "../../src/domain/changedBehavior.js";
import { createEvidence, parseEvidence } from "../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it("recovers a missing retained closure by importing the originating bundle", async () => {
  const comparisons = [FUNCTION_COMPARISON_EVIDENCE];
  const { call } = await connectLocalToolsMcp();
  const input = { comparisons };
  const retainedRequest = {
    comparisons: [
      {
        kind: "retained-evidence",
        evidence_id: FUNCTION_COMPARISON_EVIDENCE.evidence_id,
      },
    ],
  };
  const requests = [
    {
      input,
      // The inline comparison is already supplied; its missing dependencies
      // still require their originating retained Evidence closure.
      missingIds: FUNCTION_COMPARISON_EVIDENCE.evidence_links,
    },
    {
      input: retainedRequest,
      missingIds: [FUNCTION_COMPARISON_EVIDENCE.evidence_id],
    },
  ];
  for (const { input: request, missingIds } of requests) {
    const missing = parseMcpToolError(
      await call("find_changed_behavior", request),
    ).error;
    expect(missing).toMatchObject({
      code: "evidence_integrity_mismatch",
      retryable: false,
      details: {
        reason: "missing",
        reference_scope: "retained-closure",
        actual: null,
      },
    });
    expect(missingIds).toContain(missing.details?.evidence_id);
    expect(missing.message).toContain("required retained Evidence closure");
    expect(missing.remediation.action).toContain("originating Evidence bundle");
    expect(JSON.stringify(missing)).not.toContain("inline Evidence");
  }

  const directory = await createTestTempDirectory("rea-comparison-recovery-");
  const path = join(directory, "originating-bundle.json");
  await writeFile(
    path,
    JSON.stringify(
      createEvidenceBundle([
        FUNCTION_COMPARISON_EXAMPLE.left,
        FUNCTION_COMPARISON_EXAMPLE.right,
        ...comparisons,
      ]),
    ),
  );
  const imported = await call("import_evidence_bundle", { path });
  expect(imported.isError, JSON.stringify(imported)).not.toBe(true);
  const response = await call("find_changed_behavior", input);
  expect(response.isError, JSON.stringify(response)).not.toBe(true);
  const aggregate = parseEvidence(response.structuredContent);
  expect(
    changedBehaviorResultSchema.parse(aggregate.normalized_result)
      .behavior_status,
  ).toBe("unknown");
  expect(aggregate.evidence_links).toEqual(
    expect.arrayContaining([
      FUNCTION_COMPARISON_EXAMPLE.left.evidence_id,
      FUNCTION_COMPARISON_EXAMPLE.right.evidence_id,
      FUNCTION_COMPARISON_EVIDENCE.evidence_id,
    ]),
  );
  const retained = await call("find_changed_behavior", retainedRequest);
  expect(retained.isError, JSON.stringify(retained)).not.toBe(true);
  expect(parseEvidence(retained.structuredContent)).toEqual(aggregate);
});

it.each(["compact", "full"] as const)(
  "aggregates retained observations within the %s input profile budget",
  async (profile) => {
    // Distinct authenticated observations may have identical derived contents.
    const comparisons = Array.from({ length: 12 }, (_, observation) =>
      createEvidence(undefined, FUNCTION_COMPARISON_EVIDENCE.provider, {
        operation: "compare_functions",
        predicateType: "rea.function-comparison",
        parameters: { ...FUNCTION_COMPARISON_EVIDENCE.parameters, observation },
        result: FUNCTION_COMPARISON_EVIDENCE.normalized_result,
        confidence: "derived",
        authority: "analyst-inference",
        limitations: FUNCTION_COMPARISON_EVIDENCE.limitations,
        evidenceLinks: FUNCTION_COMPARISON_EVIDENCE.evidence_links,
      }),
    );
    const directory = await createTestTempDirectory(
      "rea-retained-comparisons-",
    );
    const path = join(directory, "comparisons.json");
    await writeFile(
      path,
      JSON.stringify(
        createEvidenceBundle([
          FUNCTION_COMPARISON_EXAMPLE.left,
          FUNCTION_COMPARISON_EXAMPLE.right,
          ...comparisons,
        ]),
      ),
    );
    const { call } = await connectLocalToolsMcp({
      REA_MCP_MAX_INPUT_ELEMENTS: "1024",
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
    });
    // Both refusals happen before any call initializes the deferred runtime.
    const inline = await call("find_changed_behavior", { comparisons });
    expect(parseMcpToolError(inline).error).toMatchObject({
      code: "resource_constraint",
      remediation: { action: expect.stringContaining("retained-evidence") },
      details: { reported_limits: { max_input_elements: 1024 } },
    });
    const unrelated = parseMcpToolError(
      await call("read_bytes", {
        address: "0x1000",
        length: 1,
        extra: Array.from({ length: 1024 }, () => 0),
      }),
    ).error;
    expect(unrelated.code).toBe("resource_constraint");
    expect(unrelated.remediation.action).not.toContain("retained-evidence");
    const inlineView = parseMcpToolError(
      await call("inspect_analysis_view", {
        source: {
          kind: "inline",
          evidence: {
            ...FUNCTION_COMPARISON_EXAMPLE.left,
            limitations: Array.from({ length: 1024 }, () => "limit"),
          },
        },
        view: { kind: "summary" },
      }),
    ).error;
    expect(inlineView.code).toBe("resource_constraint");
    expect(inlineView.remediation.action).toContain("retained-evidence");
    const referenceOnly = parseMcpToolError(
      await call("export_environment_bundle", {
        source: {
          kind: "retained-evidence",
          evidence_id: FUNCTION_COMPARISON_EVIDENCE.evidence_id,
        },
        output_directory: "/unused",
        template_rules: Array.from({ length: 1024 }, () => "unused"),
      }),
    ).error;
    expect(referenceOnly.code).toBe("resource_constraint");
    expect(referenceOnly.remediation.action).not.toContain("retained-evidence");
    const imported = await call("import_evidence_bundle", { path });
    expect(imported.isError, JSON.stringify(imported)).not.toBe(true);
    const response = await call("find_changed_behavior", {
      comparisons: comparisons.map(({ evidence_id }) => ({
        kind: "retained-evidence",
        evidence_id,
      })),
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const aggregate = parseEvidence(response.structuredContent);
    const result = changedBehaviorResultSchema.parse(
      aggregate.normalized_result,
    );
    expect(result.behavior_status).toBe("unknown");
    expect(result.summary.observed_changes).toBe(0);
    expect(aggregate.parameters.comparison_evidence_ids).toEqual(
      comparisons.map(({ evidence_id }) => evidence_id),
    );
    expect(
      new Set(
        result.findings.items.map(
          ({ source_comparison_id }) => source_comparison_id,
        ),
      ),
    ).toEqual(new Set(comparisons.map(({ evidence_id }) => evidence_id)));
    expect(aggregate.evidence_links).toEqual(
      expect.arrayContaining([
        FUNCTION_COMPARISON_EXAMPLE.left.evidence_id,
        FUNCTION_COMPARISON_EXAMPLE.right.evidence_id,
        ...comparisons.map(({ evidence_id }) => evidence_id),
      ]),
    );
  },
);
