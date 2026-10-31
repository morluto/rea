import { sessionOutputSchemas } from "../../../src/contracts/toolOutputSchemaGroups.js";
import { functionSnapshotFixture } from "../../../src/domain/functionDossierEvidence.fixture.js";
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

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { reconstructionVerificationResultSchema } from "../../../src/domain/reconstructionVerificationSchemas.js";
import { functionDossierSchema } from "../../../src/domain/native/functionDossier.js";

it.each([
  { leftSpace: "ram", rightSpace: "ram" },
  { leftSpace: "overlay%2f1", rightSpace: "overlay%2F1" },
  { leftSpace: "ram", rightSpace: "rom" },
])(
  "compares qualified function coordinates and retains their source spelling: $leftSpace",
  async ({ leftSpace, rightSpace }) => {
    const session = createTestBinarySession(() => {
      throw new Error(
        "Retained function comparison must not launch a provider",
      );
    });
    const harness = await createApplicationMcpHarness({ session });
    onTestFinished(harness.close);
    const source = (side: "1" | "2", space: string) => {
      const example = FUNCTION_COMPARISON_EXAMPLE.left;
      const value = functionDossierSchema.parse(example.normalized_result);
      const entry = `${space}:0x${side}000`;
      const site = `${space}:0X0${side}004`;
      value.procedure.address = entry;
      value.basic_blocks = [
        { start: entry, end: site, successors: [site] },
        {
          start: `${space}:0x${side}004`,
          end: `${space}:0x${side}008`,
          successors: [],
        },
      ];
      value.comments = [{ address: site, kind: "comment", text: "marker" }];
      value.referenced_strings = [
        { address: "rom:0x9000", source_address: site, value: "marker" },
      ];
      value.referenced_names = [
        { address: "rom:0xa000", source_address: site, value: "helper" },
      ];
      value.swift_string_literals = [
        {
          source_address: site,
          value: "swift marker",
          representation: "small",
          address: null,
          registers: ["x0", "x1"],
          words: ["0x0", "0xe"],
        },
      ];
      return createEvidence(
        {
          path: `/fixture/function-${side}`,
          sha256: side.repeat(64),
          format: "elf",
        },
        example.provider,
        {
          operation: "analyze_function",
          parameters: { procedure: entry },
          result: value,
          confidence: "derived",
          relationshipCoverage: { status: "complete" },
        },
      );
    };
    const left = source("1", leftSpace);
    const right = source("2", rightSpace);
    const response = await harness.client.callTool({
      name: "compare_functions",
      arguments: { left, right },
    });
    expect(
      response.isError,
      JSON.stringify(response.structuredContent),
    ).not.toBe(true);
    const comparison = parseEvidence(response.structuredContent);
    expect(comparison.normalized_result).toMatchObject({
      dimensions: expect.arrayContaining(
        ["cfg", "comments", "strings_names"].map((dimension) =>
          expect.objectContaining({ dimension, status: "unchanged" }),
        ),
      ),
    });
    const retained = session.exportEvidenceBundle();
    for (const original of [left, right])
      expect(
        retained.records.find(
          ({ evidence_id }) => evidence_id === original.evidence_id,
        ),
      ).toEqual(original);
  },
);

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
    const client = new Client({ name: "function-claims", version: "1" });
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
      expect(comparison.limitations).not.toContainEqual(
        expect.stringContaining(
          "without address or generated-name normalization",
        ),
      );
      expect(comparison.normalized_result).toMatchObject({
        status: comparisonStatus,
        dimensions: expect.arrayContaining(
          ["pseudocode", "assembly"].map((dimension) =>
            expect.objectContaining({
              dimension,
              limitations: expect.arrayContaining([
                expect.stringContaining(
                  "without address or generated-name normalization",
                ),
              ]),
            }),
          ),
        ),
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
            claims: ["pseudocode", "assembly", "cfg", "overall"].map(
              (dimension) => ({
                kind: "structural-function",
                claim_id: dimension,
                title: `${dimension} agrees`,
                comparison_evidence_id: comparison.evidence_id,
                dimension,
              }),
            ),
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
          total: 4,
          passed: verificationStatus === "pass" ? 4 : 2,
          failed: verificationStatus === "fail" ? 2 : 0,
          unknown: 0,
        },
        claims: {
          items: expect.arrayContaining([
            expect.objectContaining({
              dimension: "pseudocode",
              status: verificationStatus,
              observed_status: comparisonStatus,
              comparison_evidence_id: comparison.evidence_id,
              left_evidence_ids: [left.evidence_id],
              right_evidence_ids: [right.evidence_id],
              limitations: expect.arrayContaining([
                expect.stringContaining(
                  "without address or generated-name normalization",
                ),
              ]),
            }),
          ]),
        },
      });
      const claims = reconstructionVerificationResultSchema.parse(
        verification.normalized_result,
      ).claims.items;
      for (const claim of claims) {
        const caveats = claim.limitations.join(" ");
        if (claim.dimension === "cfg")
          expect(caveats).not.toMatch(/generated-name normalization/u);
        else expect(caveats).toMatch(/generated-name normalization/u);
        if (claim.dimension === "assembly" || claim.dimension === "overall")
          expect(caveats).toMatch(/Assembly is opaque/u);
        else expect(caveats).not.toMatch(/Assembly is opaque/u);
      }
      expect(
        session
          .exportEvidenceBundle()
          .records.find(({ evidence_id: id }) => id === comparison.evidence_id),
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

const wrongKindFunctionEvidence = (mismatch: "operation" | "predicate") =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation:
        mismatch === "operation" ? "inventory_artifact" : "analyze_function",
      predicateType:
        mismatch === "predicate" ? "rea.artifact-inventory" : "rea.analysis",
      parameters: {},
      result: {},
    },
  );

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
});

describe("function comparison input-kind diagnostics", () => {
  it.each([
    { side: "left", mismatch: "operation" },
    { side: "right", mismatch: "operation" },
    { side: "left", mismatch: "predicate" },
    { side: "right", mismatch: "predicate" },
  ] as const)(
    "rejects inline $side Evidence with the wrong $mismatch as an input-selection error",
    async ({ side, mismatch }) => {
      const session = createTestBinarySession(() => {
        throw new Error("Wrong-kind function input must not launch a provider");
      });
      const harness = await createApplicationMcpHarness({ session });
      onTestFinished(harness.close);
      const wrong = wrongKindFunctionEvidence(mismatch);
      const good =
        FUNCTION_COMPARISON_EXAMPLE[side === "left" ? "right" : "left"];
      const result = await harness.client.callTool({
        name: "compare_functions",
        arguments:
          side === "left"
            ? { left: wrong, right: good }
            : { left: good, right: wrong },
      });
      expect(parseMcpToolError(result).error).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        recovery: {
          kind: "inspect_input_contract",
          operation: "compare_functions",
        },
        details: {
          operation: "compare_functions",
          issues: [
            {
              path: [side],
              reason: "invalid_value",
              message: `Function analysis requires analyze_function Evidence with the rea.analysis predicate; the ${side} Evidence has operation ${wrong.operation} and predicate ${wrong.predicate_type}.`,
              expected: {
                operation: "analyze_function",
                predicate_type: "rea.analysis",
              },
            },
          ],
        },
      });
    },
  );

  it("names the retained wrong-kind Evidence side", async () => {
    const session = createTestBinarySession(() => {
      throw new Error("Wrong-kind retained input must not launch a provider");
    });
    const wrong = wrongKindFunctionEvidence("operation");
    expect(session.recordEvidence(wrong).ok).toBe(true);
    expect(session.recordEvidence(FUNCTION_COMPARISON_EXAMPLE.right).ok).toBe(
      true,
    );
    const harness = await createApplicationMcpHarness({ session });
    onTestFinished(harness.close);
    const result = await harness.client.callTool({
      name: "compare_functions",
      arguments: {
        left: { kind: "retained-evidence", evidence_id: wrong.evidence_id },
        right: {
          kind: "retained-evidence",
          evidence_id: FUNCTION_COMPARISON_EXAMPLE.right.evidence_id,
        },
      },
    });
    expect(parseMcpToolError(result).error).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        issues: [
          {
            path: ["left"],
            message: expect.stringContaining(
              "the left Evidence has operation inventory_artifact",
            ),
          },
        ],
      },
    });
    expect(session.exportEvidenceBundle().records).toHaveLength(2);
  });

  it("keeps tampered function Evidence an integrity failure", async () => {
    const session = createTestBinarySession(() => {
      throw new Error("Tampered function input must not launch a provider");
    });
    const harness = await createApplicationMcpHarness({ session });
    onTestFinished(harness.close);
    const tampered = {
      ...FUNCTION_COMPARISON_EXAMPLE.left,
      limitations: [
        ...FUNCTION_COMPARISON_EXAMPLE.left.limitations,
        "tampered",
      ],
    };
    const result = await harness.client.callTool({
      name: "compare_functions",
      arguments: { left: tampered, right: FUNCTION_COMPARISON_EXAMPLE.right },
    });
    expect(parseMcpToolError(result).error).toMatchObject({
      code: "evidence_integrity_mismatch",
      category: "integrity_mismatch",
    });
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
    const result = compareFunctions(
      functionSnapshotFixture(left),
      functionSnapshotFixture(right),
    );
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
      result: result,
    });
    const inconsistent =
      status === "unchanged"
        ? null
        : createEvidence(undefined, provider, {
            ...observation,
            result: { ...result, status: "unchanged" },
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
        code: "evidence_integrity_mismatch",
        details: {
          reason: expect.stringContaining(
            "Function comparison status contradicts its dimensions or function match",
          ),
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

describe("opt-in function comparison normalized views", () => {
  const relocationPair = () => {
    const left = FUNCTION_COMPARISON_EXAMPLE.left;
    const captured = left.normalized_result as {
      procedure: Record<string, unknown>;
    } & Record<string, unknown>;
    return [
      left,
      createEvidence(
        {
          path: "/tmp/function-relocated",
          sha256: "3".repeat(64),
          format: "mach-o",
        },
        left.provider,
        {
          operation: left.operation,
          parameters: left.parameters,
          result: jsonValueSchema.parse({
            ...captured,
            procedure: {
              ...captured.procedure,
              address: "0x2000",
              name: "FUN_00401100",
            },
            basic_blocks: [{ start: "0x2000", end: "0x2001", successors: [] }],
          }),
          confidence: left.confidence,
          authority: left.authority,
        },
      ),
    ] as const;
  };

  it("keeps the exact contract when the caller does not opt in", async () => {
    const [left, right] = relocationPair();
    const harness = await connectComparisonMcp("function-comparison-exact");
    try {
      const response = await harness.mcp.callTool({
        name: "compare_functions",
        arguments: { left, right },
      });
      const evidence = parseEvidence(response.structuredContent);
      expect(evidence.normalized_result).not.toHaveProperty("normalized_views");
      expect(evidence.parameters).not.toHaveProperty(
        "include_normalized_views",
      );
    } finally {
      await harness.close();
    }
  });

  it("returns labelled views that cite both Evidence records when requested", async () => {
    const [left, right] = relocationPair();
    const harness = await connectComparisonMcp("function-comparison-views");
    try {
      const response = await harness.mcp.callTool({
        name: "compare_functions",
        arguments: { left, right, include_normalized_views: true },
      });
      expect(response.isError).not.toBe(true);
      const exact = harness.mcp.callTool({
        name: "compare_functions",
        arguments: { left, right },
      });
      const evidence = parseEvidence(response.structuredContent);
      const exactResult = sessionOutputSchemas.compare_functions.parse(
        (await exact).structuredContent,
      ).normalized_result;
      expect(evidence.parameters).toMatchObject({
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
        include_normalized_views: true,
      });
      expect(evidence.normalized_result).toMatchObject({
        normalized_views: {
          policy: "rea-address-normalized-text-v1",
          views: [
            {
              dimension: "pseudocode_normalized",
              evidence_links: [left.evidence_id, right.evidence_id],
            },
            {
              dimension: "assembly_normalized",
              evidence_links: [left.evidence_id, right.evidence_id],
            },
          ],
        },
      });
      expect(
        (evidence.normalized_result as { dimensions: unknown }).dimensions,
      ).toEqual(exactResult.dimensions);
    } finally {
      await harness.close();
    }
  });

  it("returns the same views for retained session references", async () => {
    const [left, right] = relocationPair();
    const harness = await connectComparisonMcp(
      "function-comparison-retained-views",
    );
    try {
      for (const evidence of [left, right]) {
        const recorded = harness.session.recordEvidence(evidence);
        if (!recorded.ok) throw recorded.error;
      }
      const compare = async (inputs: object) => {
        const response = await harness.mcp.callTool({
          name: "compare_functions",
          arguments: { ...inputs, include_normalized_views: true },
        });
        expect(
          response.isError,
          JSON.stringify(response.structuredContent),
        ).not.toBe(true);
        return parseEvidence(response.structuredContent);
      };
      const retained = await compare({
        left: { kind: "retained-evidence", evidence_id: left.evidence_id },
        right: { kind: "retained-evidence", evidence_id: right.evidence_id },
      });
      const inline = await compare({ left, right });
      expect(retained.parameters).toMatchObject({
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
        include_normalized_views: true,
      });
      expect(retained.normalized_result).toHaveProperty("normalized_views");
      expect(retained.normalized_result).toEqual(inline.normalized_result);
    } finally {
      await harness.close();
    }
  });
});

const connectComparisonMcp = async (name: string) => {
  const session = createTestBinarySession(() => ({
    health: () => Promise.resolve(),
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name, version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    mcp: client,
    session,
    close: async () => {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    },
  };
};
