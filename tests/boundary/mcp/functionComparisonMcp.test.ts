import { ok as resultOk } from "../../../src/domain/result.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { compareFunctions } from "../../../src/domain/functionComparison.js";
import { jsonValueSchema } from "../../../src/domain/jsonValue.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";

describe("function comparison reconstruction MCP integration", () => {
  it.each([
    { comparisonStatus: "unchanged", verificationStatus: "pass" },
    { comparisonStatus: "changed", verificationStatus: "fail" },
  ] as const)(
    "verifies public $comparisonStatus function comparison as $verificationStatus",
    async ({ comparisonStatus, verificationStatus }) => {
      let providerLaunches = 0;
      const session = createTestBinarySession(() => {
        providerLaunches += 1;
        throw new Error("Function verification must not launch a provider");
      });
      const left = FUNCTION_COMPARISON_EXAMPLE.left;
      const right =
        comparisonStatus === "changed"
          ? FUNCTION_COMPARISON_EXAMPLE.right
          : createEvidence(
              {
                path: "/tmp/function-unchanged",
                sha256: "2".repeat(64),
                format: "mach-o",
              },
              left.provider,
              {
                operation: left.operation,
                parameters: left.parameters,
                result: left.normalized_result,
                confidence: left.confidence,
                authority: left.authority,
                ...(left.relationship_coverage === null
                  ? {}
                  : { relationshipCoverage: left.relationship_coverage }),
              },
            );
      const server = createServer({ kind: "session", session });
      const client = new Client({
        name: "function-verification-test",
        version: "1",
      });
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const compared = await client.callTool({
          name: "compare_functions",
          arguments: { left, right },
        });
        expect(compared.isError).not.toBe(true);
        const comparison = parseEvidence(compared.structuredContent);
        expect(comparison.normalized_result).toMatchObject({
          status: comparisonStatus,
        });
        expect(comparison.parameters).toEqual({
          left_evidence_id: left.evidence_id,
          right_evidence_id: right.evidence_id,
        });
        expect(comparison.evidence_links).toEqual(
          expect.arrayContaining([left.evidence_id, right.evidence_id]),
        );

        const verified = await client.callTool({
          name: "verify_reconstruction",
          arguments: {
            specification: {
              name: "Function pseudocode comparison",
              claims: [
                {
                  kind: "structural-function",
                  claim_id: "pseudocode",
                  title: "Pseudocode agrees",
                  comparison_evidence_id: comparison.evidence_id,
                  dimension: "pseudocode",
                },
              ],
            },
          },
        });
        expect(
          verified.isError,
          JSON.stringify(verified.structuredContent),
        ).not.toBe(true);
        const verification = parseEvidence(verified.structuredContent);
        expect(verification.normalized_result).toMatchObject({
          status: verificationStatus,
          summary: {
            total: 1,
            passed: verificationStatus === "pass" ? 1 : 0,
            failed: verificationStatus === "fail" ? 1 : 0,
            unknown: 0,
          },
          claims: {
            items: [
              expect.objectContaining({
                status: verificationStatus,
                observed_status: comparisonStatus,
                comparison_evidence_id: comparison.evidence_id,
                left_evidence_ids: [left.evidence_id],
                right_evidence_ids: [right.evidence_id],
              }),
            ],
          },
        });
        expect(
          session
            .exportEvidenceBundle()
            .records.find(
              ({ evidence_id: id }) => id === comparison.evidence_id,
            ),
        ).toEqual(comparison);
      } finally {
        await Promise.allSettled([
          client.close(),
          server.close(),
          session.close(),
        ]);
        expect(providerLaunches).toBe(0);
      }
    },
  );
});

describe("function comparison MCP integration", () => {
  it("records linked comparison Evidence and its residual unknown", async () => {
    const session = createTestBinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
    expect(session.recordEvidence(FUNCTION_COMPARISON_EXAMPLE.left).ok).toBe(
      true,
    );
    expect(session.recordEvidence(FUNCTION_COMPARISON_EXAMPLE.right).ok).toBe(
      true,
    );
    const server = createServer({ kind: "session", session });
    const client = new Client({
      name: "function-comparison-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "compare_functions",
        arguments: {
          left: FUNCTION_COMPARISON_EXAMPLE.left,
          right: FUNCTION_COMPARISON_EXAMPLE.right,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: { status: expect.any(String) },
        evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
      });
      const unknowns = await client.callTool({
        name: "list_unknowns",
        arguments: { domain: "function-comparison" },
      });
      expect(unknowns.structuredContent).toMatchObject({
        result: {
          items: [
            expect.objectContaining({
              domain: "function-comparison",
              recommended_probes: [
                expect.objectContaining({
                  rationale:
                    "Capture complete dossiers for both functions under the same target context.",
                }),
              ],
            }),
          ],
        },
      });
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });

  it("accepts inline Evidence without prior session registration", async () => {
    const session = createTestBinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "function-link-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "compare_functions",
        arguments: {
          left: FUNCTION_COMPARISON_EXAMPLE.left,
          right: FUNCTION_COMPARISON_EXAMPLE.right,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: { status: expect.any(String) },
      });
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });

  it("rejects inline Evidence with the wrong operation", async () => {
    const session = createTestBinarySession(() => ({
      health: () => Promise.resolve(),
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
    const wrong = createEvidence(
      undefined,
      { id: "fixture", name: "Fixture", version: "1" },
      {
        operation: "inventory_artifact",
        parameters: {},
        result: {},
      },
    );
    session.recordEvidence(wrong);
    session.recordEvidence(FUNCTION_COMPARISON_EXAMPLE.right);
    const server = createServer({ kind: "session", session });
    const client = new Client({
      name: "function-authority-test",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: "compare_functions",
        arguments: {
          left: wrong,
          right: FUNCTION_COMPARISON_EXAMPLE.right,
        },
      });
      expect(result.isError).toBe(true);
      expect(session.exportEvidenceBundle().records).toHaveLength(2);
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  });
});

it.each([
  { status: "changed", expected: "fail" },
  { status: "unknown", expected: "unknown" },
  { status: "unchanged", expected: "pass" },
] as const)(
  "checks the aggregate status of imported $status function comparisons",
  async ({ status, expected }) => {
    const left = FUNCTION_COMPARISON_EXAMPLE.left;
    const right =
      status === "changed"
        ? FUNCTION_COMPARISON_EXAMPLE.right
        : createEvidence(
            {
              path: "/fixture/function-right",
              sha256: "3".repeat(64),
              format: "mach-o",
            },
            status === "unknown"
              ? { ...left.provider, id: "other-provider" }
              : left.provider,
            {
              operation: left.operation,
              parameters: left.parameters,
              result: left.normalized_result,
              confidence: left.confidence,
              authority: left.authority,
              relationshipCoverage: { status: "complete" },
            },
          );
    const result = compareFunctions(left, right);
    expect(result.status).toBe(status);
    const provider = {
      id: "rea-function-comparison",
      name: "REA function comparison",
      version: "1",
    };
    const observation = {
      operation: "compare_functions",
      predicateType: "rea.function-comparison",
      parameters: {
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
      },
      confidence: "derived" as const,
      authority: "analyst-inference" as const,
      evidenceLinks: [left.evidence_id, right.evidence_id],
    };
    const consistent = createEvidence(undefined, provider, {
      ...observation,
      result: jsonValueSchema.parse(result),
    });
    const inconsistent =
      status === "unchanged"
        ? null
        : createEvidence(undefined, provider, {
            ...observation,
            result: jsonValueSchema.parse({ ...result, status: "unchanged" }),
          });
    const directory = await createTestTempDirectory("rea-function-status-");
    const path = join(directory, "bundle.json");
    await writeFile(
      path,
      JSON.stringify(
        createEvidenceBundle([
          left,
          right,
          consistent,
          ...(inconsistent === null ? [] : [inconsistent]),
        ]),
      ),
    );
    const session = createTestBinarySession(() => {
      throw new Error("Imported comparison must not launch a provider");
    });
    const harness = await createApplicationMcpHarness({ session });
    onTestFinished(harness.close);
    const imported = await harness.client.callTool({
      name: "import_evidence_bundle",
      arguments: { path },
    });
    expect(imported.isError).not.toBe(true);
    const verification = (evidence_id: string) =>
      harness.client.callTool({
        name: "verify_reconstruction",
        arguments: {
          specification: {
            name: "Function aggregate",
            claims: [
              {
                kind: "structural-function",
                claim_id: "overall",
                title: "Function agrees",
                comparison_evidence_id: evidence_id,
                dimension: "overall",
              },
            ],
          },
        },
      });
    if (inconsistent !== null) {
      const rejected = await verification(inconsistent.evidence_id);
      expect(parseMcpToolError(rejected).error).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              reason: "invalid_value",
              message: expect.stringContaining(
                "Function comparison status contradicts its dimensions or function match",
              ),
            },
          ],
        },
      });
      expect(harness.session.evidenceById(inconsistent.evidence_id)).toEqual(
        inconsistent,
      );
    }
    const verified = await verification(consistent.evidence_id);
    expect(verified.isError).not.toBe(true);
    expect(
      parseEvidence(verified.structuredContent).normalized_result,
    ).toMatchObject({ status: expected });
    await harness.client.ping();
  },
);
