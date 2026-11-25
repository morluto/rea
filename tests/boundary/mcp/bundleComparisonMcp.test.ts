import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { compareEvidenceBundlesCommand } from "../../../src/application/EvidenceBundleCommands.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  bundleComparisonInputSchema,
  bundleComparisonResultSchema,
} from "../../../src/domain/bundleComparison.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  serializeEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const sourceEvidence = (label: string, resultKey = "label") =>
  createEvidence(
    unknownTarget("not-observed"),
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "observe",
      parameters: { label },
      result: { [resultKey]: label },
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );

it("requires absolute bundle paths without changing server-cwd semantics", async () => {
  const root = await createTestTempDirectory("rea-bundle-relative-mcp-");
  const encoded = serializeEvidenceBundle(createEvidenceBundle([]));
  await Promise.all([
    writeFile(join(root, "left.json"), encoded),
    writeFile(join(root, "right.json"), encoded),
  ]);
  const connected = await connect();
  const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
  try {
    const compare = (leftPath: string, rightPath: string) =>
      connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: leftPath,
          right_bundle_path: rightPath,
        },
      });
    const relativeCases = [
      ["left.json", "right.json", "left_bundle_path"],
      ["left.json", join(root, "right.json"), "left_bundle_path"],
      [join(root, "left.json"), "right.json", "right_bundle_path"],
    ] as const;
    for (const [leftPath, rightPath, rejectedField] of relativeCases) {
      const result = await compare(leftPath, rightPath);
      expect(parseMcpToolError(result).error).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        details: {
          operation: "compare_bundles",
          issues: expect.arrayContaining([
            expect.objectContaining({
              path: [rejectedField],
              reason: "invalid_format",
              expected: "regex",
            }),
          ]),
        },
      });
    }
    expect(
      bundleComparisonInputSchema.parse({
        left_bundle_path: "left.json",
        right_bundle_path: "right.json",
      }),
    ).toMatchObject({
      left_bundle_path: "left.json",
      right_bundle_path: "right.json",
    });
    const cliCommand = await compareEvidenceBundlesCommand({
      leftPath: "left.json",
      rightPath: "right.json",
    });
    expect(cliCommand).toMatchObject({
      ok: true,
      value: { status: "unchanged" },
    });
    const relativeImport = await connected.client.callTool({
      name: "import_evidence_bundle",
      arguments: { path: "left.json" },
    });
    expect(parseMcpToolError(relativeImport).error).toMatchObject({
      code: "invalid_request",
      category: "invalid_input",
      details: {
        operation: "import_evidence_bundle",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["path"],
            reason: "invalid_format",
          }),
        ]),
      },
    });
    const absolute = await compare(
      join(root, "left.json"),
      join(root, "right.json"),
    );
    expect(absolute.isError).not.toBe(true);
    expect(absolute.structuredContent).toMatchObject({
      normalized_result: { status: "unchanged" },
    });
  } finally {
    await connected.close();
    cwd.mockRestore();
  }
});

describe("bundle comparison MCP integration", () => {
  it("retains both sources from caller-selected bundles without explicit pairs", async () => {
    const root = await createTestTempDirectory("rea-bundle-mcp-");
    const leftPath = join(root, "left.json");
    const rightPath = join(root, "right.json");
    const leftRecord = sourceEvidence("left\ud800", "\udc00");
    // This ID was produced with the pre-upgrade Evidence encoding.
    expect(leftRecord.evidence_id).toBe(
      "ev_55aa3cd58e7b32f08302046ee039c28349f9d51835af2be9e5eb2ad94ae8a1f5",
    );
    const rightRecord = sourceEvidence("right");
    await Promise.all([
      writeFile(
        leftPath,
        serializeEvidenceBundle(createEvidenceBundle([leftRecord])),
      ),
      writeFile(
        rightPath,
        serializeEvidenceBundle(createEvidenceBundle([rightRecord])),
      ),
    ]);
    const connected = await connect();
    try {
      const result = await connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: leftPath,
          right_bundle_path: rightPath,
          record_pairs: [],
        },
      });
      expect(result.isError).not.toBe(true);
      const evidence = toolContract("compare_bundles").outputSchema.parse(
        result.structuredContent,
      );
      expect(evidence).toMatchObject({
        normalized_result: { status: "unknown", summary: { unresolved: 2 } },
        evidence_links: [leftRecord.evidence_id, rightRecord.evidence_id],
        evidence_id: expect.stringMatching(/^ev_[a-f0-9]{64}$/u),
      });
      const retained = connected.session.exportEvidenceBundle().records;
      expect(retained).toHaveLength(3);
      expect(retained).toEqual(
        expect.arrayContaining([leftRecord, rightRecord, evidence]),
      );
    } finally {
      await connected.close();
    }
  });

  it("reads a bundle path outside any configured roots", async () => {
    const root = await createTestTempDirectory("rea-bundle-root-");
    const outside = await createTestTempDirectory("rea-bundle-outside-");
    const leftPath = join(root, "left.json");
    const rightPath = join(outside, "right.json");
    const encoded = serializeEvidenceBundle(createEvidenceBundle([]));
    await Promise.all([
      writeFile(leftPath, encoded),
      writeFile(rightPath, encoded),
    ]);
    const connected = await connect();
    try {
      const result = await connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: leftPath,
          right_bundle_path: rightPath,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: { status: "unchanged" },
      });
    } finally {
      await connected.close();
    }
  });

  it("explains that a single Evidence record is not a bundle", async () => {
    const root = await createTestTempDirectory("rea-bundle-record-");
    const record = sourceEvidence("single");
    const recordPath = join(root, "record.json");
    const bundlePath = join(root, "bundle.json");
    await Promise.all([
      writeFile(recordPath, JSON.stringify(record)),
      writeFile(
        bundlePath,
        serializeEvidenceBundle(createEvidenceBundle([record])),
      ),
    ]);
    const connected = await connect();
    try {
      const result = await connected.client.callTool({
        name: "compare_bundles",
        arguments: {
          left_bundle_path: recordPath,
          right_bundle_path: bundlePath,
        },
      });
      expect(parseMcpToolError(result)).toMatchObject({
        error: {
          code: "invalid_request",
          category: "invalid_input",
          details: { path: recordPath, detected_kind: "evidence-record" },
          message: expect.stringContaining(record.evidence_id),
        },
      });
    } finally {
      await connected.close();
    }
  });
});

describe("bundle comparison record selections", () => {
  it.each([
    {
      label: "missing left evidence",
      pairs: (
        _left: readonly ReturnType<typeof sourceEvidence>[],
        right: readonly ReturnType<typeof sourceEvidence>[],
      ) => [
        {
          left_evidence_id: sourceEvidence("absent-left").evidence_id,
          right_evidence_id: right[0]!.evidence_id,
        },
      ],
      path: ["record_pairs", 0, "left_evidence_id"],
      message: "missing left evidence",
    },
    {
      label: "missing right evidence",
      pairs: (
        left: readonly ReturnType<typeof sourceEvidence>[],
        _right: readonly ReturnType<typeof sourceEvidence>[],
      ) => [
        {
          left_evidence_id: left[0]!.evidence_id,
          right_evidence_id: sourceEvidence("absent-right").evidence_id,
        },
      ],
      path: ["record_pairs", 0, "right_evidence_id"],
      message: "missing right evidence",
    },
    {
      label: "duplicate left evidence",
      pairs: (
        left: readonly ReturnType<typeof sourceEvidence>[],
        right: readonly ReturnType<typeof sourceEvidence>[],
      ) => [
        {
          left_evidence_id: left[0]!.evidence_id,
          right_evidence_id: right[0]!.evidence_id,
        },
        {
          left_evidence_id: left[0]!.evidence_id,
          right_evidence_id: right[1]!.evidence_id,
        },
      ],
      path: ["record_pairs", 1, "left_evidence_id"],
      message: "one-to-one",
    },
    {
      label: "duplicate right evidence",
      pairs: (
        left: readonly ReturnType<typeof sourceEvidence>[],
        right: readonly ReturnType<typeof sourceEvidence>[],
      ) => [
        {
          left_evidence_id: left[0]!.evidence_id,
          right_evidence_id: right[0]!.evidence_id,
        },
        {
          left_evidence_id: left[1]!.evidence_id,
          right_evidence_id: right[0]!.evidence_id,
        },
      ],
      path: ["record_pairs", 1, "right_evidence_id"],
      message: "one-to-one",
    },
  ])(
    "reports the precise path for $label without publishing Evidence",
    async ({ pairs, path, message }) => {
      const root = await createTestTempDirectory(
        "rea-bundle-pairs-invalid-mcp-",
      );
      const left = [sourceEvidence("left-1"), sourceEvidence("left-2")];
      const right = [sourceEvidence("right-1"), sourceEvidence("right-2")];
      const leftPath = join(root, "left.json");
      const rightPath = join(root, "right.json");
      await Promise.all([
        writeFile(
          leftPath,
          serializeEvidenceBundle(createEvidenceBundle(left)),
        ),
        writeFile(
          rightPath,
          serializeEvidenceBundle(createEvidenceBundle(right)),
        ),
      ]);
      const connected = await connect();
      try {
        const result = await connected.client.callTool({
          name: "compare_bundles",
          arguments: {
            left_bundle_path: leftPath,
            right_bundle_path: rightPath,
            record_pairs: pairs(left, right),
          },
        });
        expect(parseMcpToolError(result).error).toMatchObject({
          code: "invalid_request",
          category: "invalid_input",
          message: expect.stringContaining(message),
          details: {
            issues: [expect.objectContaining({ path })],
          },
        });
        expect(connected.session.exportEvidenceBundle().records).toEqual([]);
      } finally {
        await connected.close();
      }
    },
  );
});

const connect = async () => {
  const session = createTestBinarySession(() => ({
    health: () => Promise.resolve(),
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer({ kind: "session", session });
  const client = new Client(
    { name: "bundle-comparison-test", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
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
