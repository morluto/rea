import { expect, it } from "vitest";

import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { functionDossierSchema } from "../../../src/domain/native/functionDossier.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import type { RelationshipCoverage } from "../../../src/domain/relationshipCoverage.js";
import { functionComparisonResultSchema } from "../../../src/domain/functionComparisonSchemas.js";

const sourceWithCoverage = (
  template: typeof FUNCTION_COMPARISON_EXAMPLE.left,
  observation: string,
  result: typeof template.normalized_result,
  relationshipCoverage: RelationshipCoverage,
) => {
  if (template.subject === null)
    throw new Error("Function comparison fixtures must be artifact-bound");
  return createEvidence(
    {
      path: `${template.subject.local_path}/${observation}`,
      sha256: template.subject.digest.sha256,
      format: template.subject.format,
    },
    template.provider,
    {
      operation: "analyze_function",
      parameters: { ...template.parameters, observation },
      result,
      confidence: template.confidence,
      authority: template.authority,
      relationshipCoverage,
    },
  );
};

it.each(["full", "compact"] as const)(
  "qualifies observed calls and verifies discovery independently (%s)",
  async (profile) => {
    for (const [label, coverage, status] of [
      [
        "partial",
        {
          status: "complete",
          discovery: {
            callers: { status: "complete" },
            callees: {
              status: "partial",
              reason: "The fixture body is classified as data.",
            },
          },
        },
        "unknown",
      ],
      ["unreported", { status: "complete" }, "unknown"],
      [
        "complete",
        {
          status: "complete",
          discovery: {
            callers: { status: "complete" },
            callees: { status: "complete" },
          },
        },
        "pass",
      ],
    ] as const) {
      const session = createTestBinarySession(() => {
        throw new Error("offline comparison must not launch a provider");
      });
      const { client } = await createApplicationMcpHarness({
        session,
        serverOptions: {
          environment: { REA_MCP_OUTPUT_SCHEMA_PROFILE: profile },
        },
      });
      const left = sourceWithCoverage(
        FUNCTION_COMPARISON_EXAMPLE.left,
        `${label}-left`,
        FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
        coverage,
      );
      const right = sourceWithCoverage(
        FUNCTION_COMPARISON_EXAMPLE.right,
        `${label}-right`,
        FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
        coverage,
      );
      const compared = await client.callTool({
        name: "compare_functions",
        arguments: { left, right },
      });
      if (compared.isError) throw new Error(JSON.stringify(compared));
      const comparison = parseEvidence(compared.structuredContent);
      expect(comparison.normalized_result).toMatchObject({
        dimensions: expect.arrayContaining([
          expect.objectContaining({
            dimension: "calls",
            status: "unchanged",
            ...(label === "partial"
              ? {
                  limitations: expect.arrayContaining([
                    expect.stringContaining(
                      "The fixture body is classified as data.",
                    ),
                  ]),
                }
              : {}),
          }),
        ]),
      });
      const result = await verify(
        (name, arguments_) => client.callTool({ name, arguments: arguments_ }),
        comparison,
        ["calls"],
      );
      expect(result.normalized_result).toMatchObject({
        claims: {
          items: [
            {
              claim_id: "calls",
              status,
              observed_status: "unchanged",
              ...(label === "partial"
                ? {
                    limitations: expect.arrayContaining([
                      expect.stringContaining(
                        "The fixture body is classified as data.",
                      ),
                    ]),
                  }
                : {}),
            },
          ],
        },
      });
      if (label === "unreported") {
        const current = functionComparisonResultSchema.parse(
          comparison.normalized_result,
        );
        const historical = createEvidence(undefined, comparison.provider, {
          predicateType: comparison.predicate_type,
          operation: comparison.operation,
          parameters: comparison.parameters,
          result: {
            ...current,
            dimensions: current.dimensions.map((dimension) =>
              dimension.dimension === "calls"
                ? { ...dimension, limitations: [] }
                : dimension,
            ),
          },
          confidence: comparison.confidence,
          authority: comparison.authority,
          limitations: comparison.limitations,
          evidenceLinks: comparison.evidence_links,
        });
        expect(session.recordEvidence(historical).ok).toBe(true);
        const prior = await verify(
          (name, arguments_) =>
            client.callTool({ name, arguments: arguments_ }),
          historical,
          ["calls"],
        );
        expect(prior.normalized_result).toMatchObject({
          claims: {
            items: [{ status: "unknown", observed_status: "unchanged" }],
          },
        });
        expect(session.evidenceById(historical.evidence_id)).toEqual(
          historical,
        );
      }
    }
  },
);

const verify = async (
  call: (
    name: string,
    arguments_: Record<string, unknown>,
  ) => Promise<{
    readonly isError?: boolean | undefined;
    readonly structuredContent?: unknown | undefined;
  }>,
  comparison: ReturnType<typeof parseEvidence>,
  dimensions: readonly ("calls" | "overall" | "pseudocode")[],
) => {
  const response = await call("verify_reconstruction", {
    specification: {
      name: "Function call coverage verification",
      claims: dimensions.map((dimension) => ({
        kind: "structural-function",
        claim_id: dimension,
        title: `Check ${dimension}`,
        comparison_evidence_id: comparison.evidence_id,
        dimension,
      })),
    },
  });
  expect(response.isError, JSON.stringify(response.structuredContent)).not.toBe(
    true,
  );
  return parseEvidence(response.structuredContent);
};

it("keeps an observed call-set difference without claiming a verified difference", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("offline comparison must not launch a provider");
  });
  const { client } = await createApplicationMcpHarness({ session });
  const original = functionDossierSchema.parse(
    FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
  );
  const coverage: RelationshipCoverage = {
    status: "complete",
    discovery: {
      callers: { status: "complete" },
      callees: { status: "partial", reason: "Not all bodies were classified." },
    },
  };
  const left = sourceWithCoverage(
    FUNCTION_COMPARISON_EXAMPLE.left,
    "difference-left",
    jsonValueSchema.parse({ ...original, callees: [] }),
    coverage,
  );
  const {
    signature: _signature,
    locals: _locals,
    ...helper
  } = original.procedure;
  const right = sourceWithCoverage(
    FUNCTION_COMPARISON_EXAMPLE.right,
    "difference-right",
    jsonValueSchema.parse({
      ...original,
      callees: [{ ...helper, address: "0x2000", name: "helper" }],
    }),
    coverage,
  );
  const response = await client.callTool({
    name: "compare_functions",
    arguments: { left, right },
  });
  if (response.isError) throw new Error(JSON.stringify(response));
  const comparison = parseEvidence(response.structuredContent);
  expect(comparison.normalized_result).toMatchObject({
    dimensions: expect.arrayContaining([
      expect.objectContaining({
        dimension: "calls",
        status: "changed",
        limitations: expect.arrayContaining([
          expect.stringContaining("Not all bodies were classified."),
        ]),
      }),
    ]),
  });
  const result = await verify(
    (name, arguments_) => client.callTool({ name, arguments: arguments_ }),
    comparison,
    ["calls"],
  );
  expect(result.normalized_result).toMatchObject({
    claims: { items: [{ status: "unknown", observed_status: "changed" }] },
  });
});

const assertChangedDespiteUnknownCalls = async (
  call: Parameters<typeof verify>[0],
  left: ReturnType<typeof parseEvidence>,
): Promise<void> => {
  const changedRight = sourceWithCoverage(
    FUNCTION_COMPARISON_EXAMPLE.right,
    "coverage-changed-right",
    jsonValueSchema.parse({
      ...functionDossierSchema.parse(
        FUNCTION_COMPARISON_EXAMPLE.right.normalized_result,
      ),
      pseudocode: "return 1;",
    }),
    { status: "unknown", reason: "Call graph unavailable." },
  );
  const changed = await call("compare_functions", {
    left,
    right: changedRight,
  });
  expect(changed.isError, JSON.stringify(changed.structuredContent)).not.toBe(
    true,
  );
  const changedComparison = parseEvidence(changed.structuredContent);
  expect(changedComparison.normalized_result).toMatchObject({
    status: "changed",
    dimensions: expect.arrayContaining([
      expect.objectContaining({ dimension: "calls", status: "unknown" }),
      expect.objectContaining({ dimension: "pseudocode", status: "changed" }),
    ]),
  });
  const verification = await verify(call, changedComparison, ["overall"]);
  expect(verification.normalized_result).toMatchObject({
    status: "fail",
    summary: { total: 1, passed: 0, failed: 1, unknown: 0 },
    claims: {
      items: [
        expect.objectContaining({
          claim_id: "overall",
          status: "fail",
          observed_status: "changed",
        }),
      ],
    },
  });
};

it("keeps incomplete calls unknown through public comparison and verification while preserving confirmed changes", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Function comparison must not launch a provider");
  });
  const { client } = await createApplicationMcpHarness({
    session,
    clientIdentity: { name: "function-coverage-test", version: "1" },
    serverOptions: {
      environment: {
        ...process.env,
        REA_MCP_MAX_INPUT_ELEMENTS: process.env.REA_MCP_MAX_INPUT_ELEMENTS,
      },
    },
  });
  const left = sourceWithCoverage(
    FUNCTION_COMPARISON_EXAMPLE.left,
    "coverage-left",
    FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
    { status: "complete" },
  );
  const right = sourceWithCoverage(
    FUNCTION_COMPARISON_EXAMPLE.right,
    "coverage-right",
    FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
    { status: "unknown", reason: "Call graph unavailable." },
  );
  expect(left.subject).not.toBeNull();
  expect(right.subject).not.toBeNull();
  expect(left.limitations).not.toContain(
    "Artifact identity is unavailable for this observation.",
  );
  expect(right.limitations).not.toContain(
    "Artifact identity is unavailable for this observation.",
  );
  const compared = await client.callTool({
    name: "compare_functions",
    arguments: { left, right },
  });
  expect(compared.isError, JSON.stringify(compared.structuredContent)).not.toBe(
    true,
  );
  const comparison = parseEvidence(compared.structuredContent);
  expect(session.evidenceById(left.evidence_id)?.subject).toEqual(
    expect.any(Object),
  );
  expect(session.evidenceById(right.evidence_id)?.subject).toEqual(
    expect.any(Object),
  );
  expect(comparison.normalized_result).toMatchObject({
    status: "unknown",
    summary: { unchanged: 7, changed: 0, unknown: 1 },
    dimensions: expect.arrayContaining([
      expect.objectContaining({
        dimension: "calls",
        status: "unknown",
        conclusion_kind: "unresolved_branch",
        left_count: 0,
        right_count: 0,
        limitations: expect.arrayContaining([
          "Right: Call graph unavailable.",
          "Left: Static direct-call discovery is not established for callers and callees.",
          "Right: Static direct-call discovery is not established for callers and callees.",
        ]),
        evidence_links: [left.evidence_id, right.evidence_id],
      }),
    ]),
  });
  expect(comparison.evidence_links).toEqual(
    expect.arrayContaining([left.evidence_id, right.evidence_id]),
  );

  const unknowns = await client.callTool({
    name: "list_unknowns",
    arguments: { domain: "function-comparison" },
  });
  expect(unknowns.isError).not.toBe(true);
  expect(unknowns.structuredContent).toMatchObject({
    result: {
      items: [
        expect.objectContaining({
          domain: "function-comparison",
          status: "open",
          supporting_evidence_ids: expect.arrayContaining([
            left.evidence_id,
            right.evidence_id,
          ]),
        }),
      ],
    },
  });

  const verification = await verify(
    async (name, arguments_) =>
      client.callTool({ name, arguments: arguments_ }),
    comparison,
    ["calls", "overall", "pseudocode"],
  );
  expect(verification.normalized_result).toMatchObject({
    status: "unknown",
    summary: { total: 3, passed: 1, failed: 0, unknown: 2 },
    claims: {
      items: expect.arrayContaining([
        expect.objectContaining({
          claim_id: "calls",
          status: "unknown",
          observed_status: "unknown",
        }),
        expect.objectContaining({
          claim_id: "overall",
          status: "unknown",
          observed_status: "unknown",
        }),
        expect.objectContaining({
          claim_id: "pseudocode",
          status: "pass",
          observed_status: "unchanged",
        }),
      ]),
    },
  });

  await assertChangedDespiteUnknownCalls(
    async (name, arguments_) =>
      client.callTool({ name, arguments: arguments_ }),
    left,
  );
});
