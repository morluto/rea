import { cliTest } from "../../support/cli/cliFixture.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { BYTE_ENTROPY_PROVIDER } from "../../../src/domain/investigationProviders.js";
import { byteEntropySchema } from "../../../src/domain/native/byteEntropy.js";
import {
  byteEntropyPageViewResultSchema,
  byteEntropySummaryViewResultSchema,
} from "../../../src/domain/analysisView/analysisViewResult.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";

import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { analysisViewLayoutFixture } from "../../fixtures/analysisView.js";
import { BINARY_LAYOUT_TEST_PROVIDER } from "../../fixtures/binaryDiagnostics/layout.js";
import { inspectionTestProvider } from "../../fixtures/binaryDiagnostics/inspectionProvider.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const contract = toolContract("analyze_javascript_application");

const connect = async (
  retainsEvidence: boolean,
  binaryLayout?: BinaryLayoutService,
) => {
  const session = createTestBinarySession(() => {
    throw new Error("JavaScript analysis must not start a deep provider");
  });
  const server = createServer(
    retainsEvidence
      ? { kind: "session", session }
      : {
          kind: "fixed",
          analysis: {
            execute: () => {
              throw new Error("JavaScript analysis must not use a target");
            },
          },
        },
    binaryLayout === undefined ? {} : { binaryLayout },
  );
  const client = new Client(
    { name: "analysis-summary-detail", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const application = async () => {
  const root = await createTestTempDirectory("rea-summary-detail-");
  await writeFile(
    join(root, "main.js"),
    'import { helper } from "./util.js";\nexport const greet = (name) => helper(name);\n',
  );
  await writeFile(
    join(root, "util.js"),
    "export const helper = (value) => value.toUpperCase();\n",
  );
  return { input_path: root, format: "directory" };
};

const textBytes = (content: unknown): number => {
  const [first] = Array.isArray(content) ? content : [];
  if (first?.type !== "text") throw new Error("Missing MCP text result");
  return Buffer.byteLength(String(first.text));
};

it("returns the summary of complete Evidence retained for later views", async () => {
  const client = await connect(true);
  const input = await application();
  const complete = await client.callTool({
    name: contract.name,
    arguments: { ...input, detail: "complete" },
  });
  expect(complete.isError).not.toBe(true);
  const completeEvidence = contract.outputSchema.parse(
    complete.structuredContent,
  );
  expect(completeEvidence.operation).toBe("analyze_javascript_application");

  const summary = await client.callTool({
    name: contract.name,
    arguments: { ...input, detail: "summary" },
  });
  expect(summary.isError).not.toBe(true);
  const summaryEvidence = contract.outputSchema.parse(
    summary.structuredContent,
  );
  expect(summaryEvidence).toMatchObject({
    operation: "inspect_analysis_view",
    evidence_links: [completeEvidence.evidence_id],
    normalized_result: {
      kind: "summary",
      parent_evidence_id: completeEvidence.evidence_id,
      parent_operation: "analyze_javascript_application",
    },
  });
  expect(textBytes(summary.content)).toBeLessThan(textBytes(complete.content));

  const modules = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: completeEvidence.evidence_id,
      },
      view: { kind: "page", collection: "modules", offset: 0, limit: 8 },
    },
  });
  expect(modules.isError).not.toBe(true);
  expect(modules.structuredContent).toMatchObject({
    normalized_result: {
      kind: "page",
      parent_evidence_id: completeEvidence.evidence_id,
      items: expect.arrayContaining([
        expect.objectContaining({ kind: "javascript-module", path: "main.js" }),
        expect.objectContaining({ kind: "javascript-module", path: "util.js" }),
      ]),
    },
  });
});

it("refuses summary detail when the server cannot retain the complete Evidence", async () => {
  const client = await connect(false);
  const failure = parseMcpToolError(
    await client.callTool({
      name: contract.name,
      arguments: { ...(await application()), detail: "summary" },
    }),
  );
  expect(failure.error).toMatchObject({
    code: "capability_unavailable",
    message: expect.stringContaining("detail complete"),
  });
});

it("returns the summary of retained binary layout Evidence", async () => {
  const layout = analysisViewLayoutFixture();
  const client = await connect(
    true,
    new BinaryLayoutService(
      inspectionTestProvider(BINARY_LAYOUT_TEST_PROVIDER, () =>
        Promise.resolve(ok(layout)),
      ),
    ),
  );
  const layoutContract = toolContract("inspect_binary_layout");
  const summary = await client.callTool({
    name: layoutContract.name,
    arguments: { path: layout.artifact.path, detail: "summary" },
  });
  expect(summary.isError).not.toBe(true);
  const evidence = layoutContract.outputSchema.parse(summary.structuredContent);
  expect(evidence).toMatchObject({
    operation: "inspect_analysis_view",
    normalized_result: {
      kind: "summary",
      parent_operation: "inspect_binary_layout",
    },
  });
  const [parentId] = evidence.evidence_links;
  const sections = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "retained-evidence", evidence_id: parentId },
      view: { kind: "page", collection: "sections", offset: 0, limit: 8 },
    },
  });
  expect(sections.isError).not.toBe(true);
  expect(sections.structuredContent).toMatchObject({
    normalized_result: {
      kind: "page",
      parent_evidence_id: parentId,
      items: [
        expect.objectContaining({
          index: 0,
          name: expect.objectContaining({ display: ".text" }),
        }),
        expect.objectContaining({
          index: 1,
          name: expect.objectContaining({ display: ".text" }),
        }),
        expect.objectContaining({
          index: 2,
          name: expect.objectContaining({ display: ".data" }),
        }),
      ],
    },
  });
});

cliTest(
  "retains complete entropy Evidence, summarizes runs and matches CLI JSON",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-entropy-summary-");
    const path = join(root, "bytes");
    await writeFile(path, Buffer.alloc(65536));
    const client = await connect(true);
    const input = { path, block_size: 256, offset: 7, length: 32769 };
    const complete = await client.callTool({
      name: "inspect_byte_entropy",
      arguments: input,
    });
    expect(complete.isError).not.toBe(true);
    const evidence = parseEvidence(complete.structuredContent);
    const cliResult = await cli.run({
      arguments: [
        "inspect-byte-entropy",
        path,
        "--block-size",
        "256",
        "--offset",
        "7",
        "--length",
        "32769",
        "--json",
      ],
      environment: process.env,
    });
    expect(cliResult.exitCode).toBe(0);
    expect(cliResult.signal).toBeNull();
    const cliEvidence = parseEvidence(cliResult.json);
    expect(cliEvidence.normalized_result).toEqual(evidence.normalized_result);
    expect(cliEvidence.evidence_id).toBe(evidence.evidence_id);
    const summary = await client.callTool({
      name: "inspect_byte_entropy",
      arguments: { ...input, detail: "summary" },
    });
    expect(summary.isError).not.toBe(true);
    const view = byteEntropySummaryViewResultSchema.parse(
      parseEvidence(summary.structuredContent).normalized_result,
    );
    expect(view).toMatchObject({
      parent_evidence_id: evidence.evidence_id,
      summary: {
        file_entropy: 0,
        block_count: 129,
        run_count: 1,
        runs: [{ offset: 7, length: 32769, classification: "low" }],
        top_runs: [{ offset: 7, length: 32769, classification: "low" }],
      },
    });
    const retained = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: {
          kind: "retained-evidence",
          evidence_id: view.parent_evidence_id,
        },
        view: { kind: "summary" },
      },
    });
    expect(retained.isError).not.toBe(true);
    expect(parseEvidence(retained.structuredContent).normalized_result).toEqual(
      view,
    );
    expect(textBytes(summary.content)).toBeLessThan(
      textBytes(complete.content),
    );
    const blocks = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: {
          kind: "retained-evidence",
          evidence_id: view.parent_evidence_id,
        },
        view: {
          kind: "byte-entropy",
          collection: "blocks",
          offset: 127,
          limit: 4,
        },
      },
    });
    expect(blocks.isError).not.toBe(true);
    const completeReport = byteEntropySchema.parse(evidence.normalized_result);
    expect(
      parseEvidence(blocks.structuredContent).normalized_result,
    ).toMatchObject({
      kind: "byte-entropy",
      parent_evidence_id: evidence.evidence_id,
      entropy: { block_count: 129, run_count: 1 },
      items: completeReport.blocks.slice(127),
      coverage: { examined: 2, total: 129, next_offset: null },
    });
    expect(
      (
        await client.callTool({
          name: "inspect_analysis_view",
          arguments: {
            source: {
              kind: "retained-evidence",
              evidence_id: view.parent_evidence_id,
            },
            view: { kind: "page", collection: "sections", offset: 0, limit: 1 },
          },
        })
      ).isError,
    ).toBe(true);
    const fixed = await connect(false);
    expect(
      (
        await fixed.callTool({
          name: "inspect_byte_entropy",
          arguments: { path, detail: "summary" },
        })
      ).isError,
    ).toBe(true);
  },
);

it("filters retained byte entropy blocks by threshold and run boundaries across MCP", async () => {
  const root = await createTestTempDirectory("rea-entropy-filter-mcp-");
  const path = join(root, "multi-run.bin");
  const bytes = Buffer.alloc(38 * 256);
  const highBlock = Buffer.from(Array.from({ length: 256 }, (_, b) => b));
  for (let index = 16; index < 22; index += 1)
    highBlock.copy(bytes, index * 256);
  await writeFile(path, bytes);
  const client = await connect(true);
  const summaryCall = await client.callTool({
    name: "inspect_byte_entropy",
    arguments: { path, block_size: 256, detail: "summary" },
  });
  expect(summaryCall.isError).not.toBe(true);
  const summary = byteEntropySummaryViewResultSchema.parse(
    parseEvidence(summaryCall.structuredContent).normalized_result,
  );
  const boundariesCall = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: summary.parent_evidence_id,
      },
      view: {
        kind: "byte-entropy",
        collection: "blocks",
        run_boundaries_only: true,
      },
    },
  });
  expect(boundariesCall.isError).not.toBe(true);
  const boundaries = byteEntropyPageViewResultSchema.parse(
    parseEvidence(boundariesCall.structuredContent).normalized_result,
  );
  expect(boundaries).toMatchObject({
    entropy: { block_count: 38, run_count: 3 },
    items: [
      { offset: 0, length: 256, entropy: 0 },
      { offset: 15 * 256, length: 256, entropy: 0 },
      { offset: 16 * 256, length: 256, entropy: 8 },
      { offset: 21 * 256, length: 256, entropy: 8 },
      { offset: 22 * 256, length: 256, entropy: 0 },
      { offset: 37 * 256, length: 256, entropy: 0 },
    ],
    coverage: {
      status: "page",
      examined: 6,
      total: 6,
      next_offset: null,
      exhausted: true,
      examined_blocks: 38,
      matched_blocks: 6,
    },
  });
  const firstHigh = byteEntropyPageViewResultSchema.parse(
    parseEvidence(
      (
        await client.callTool({
          name: "inspect_analysis_view",
          arguments: {
            source: {
              kind: "retained-evidence",
              evidence_id: summary.parent_evidence_id,
            },
            view: {
              kind: "byte-entropy",
              collection: "blocks",
              min_entropy: 7.2,
              offset: 0,
              limit: 4,
            },
          },
        })
      ).structuredContent,
    ).normalized_result,
  );
  expect(firstHigh.coverage).toEqual({
    status: "page",
    examined: 4,
    total: 6,
    next_offset: 4,
    exhausted: false,
    examined_blocks: 38,
    matched_blocks: 6,
  });
  const nextHigh = byteEntropyPageViewResultSchema.parse(
    parseEvidence(
      (
        await client.callTool({
          name: "inspect_analysis_view",
          arguments: {
            source: {
              kind: "retained-evidence",
              evidence_id: summary.parent_evidence_id,
            },
            view: {
              kind: "byte-entropy",
              collection: "blocks",
              min_entropy: 7.2,
              offset: firstHigh.coverage.next_offset!,
              limit: 4,
            },
          },
        })
      ).structuredContent,
    ).normalized_result,
  );
  expect(nextHigh.items).toHaveLength(2);
  expect(nextHigh.coverage).toEqual({
    status: "page",
    examined: 2,
    total: 6,
    next_offset: null,
    exhausted: true,
    examined_blocks: 38,
    matched_blocks: 6,
  });
});

it("returns boundary blocks of a 2 GiB 32768-block sparse window in one MCP call", async () => {
  const root = await createTestTempDirectory("rea-entropy-sparse-mcp-");
  const evidencePath = join(root, "sparse-2g.json");
  const artifactPath = join(root, "sparse-3g.bin");
  const blockSize = 65_536;
  const windowLength = 2 * 1024 ** 3;
  const highBlockIndex = 16_384;
  const blocks = Array.from({ length: 32_768 }, (_, index) => ({
    offset: index * blockSize,
    length: blockSize,
    entropy: index === highBlockIndex ? 8 : 0,
  }));
  const report = byteEntropySchema.parse({
    artifact: {
      path: artifactPath,
      bytes: 3 * 1024 ** 3,
      sha256: "a".repeat(64),
    },
    block_size: blockSize,
    window: { offset: 0, length: windowLength },
    file_entropy: 0.0005,
    thresholds: { high: 7.2, low: 1 },
    blocks,
    runs: [
      { offset: 0, length: highBlockIndex * blockSize, classification: "low" },
      {
        offset: highBlockIndex * blockSize,
        length: blockSize,
        classification: "high",
      },
      {
        offset: (highBlockIndex + 1) * blockSize,
        length: (32_768 - highBlockIndex - 1) * blockSize,
        classification: "low",
      },
    ],
    limitations: [],
  });
  const evidence = createEvidence(
    { path: artifactPath, format: "file", sha256: report.artifact.sha256 },
    BYTE_ENTROPY_PROVIDER,
    {
      operation: "inspect_byte_entropy",
      parameters: {
        path: artifactPath,
        block_size: blockSize,
        offset: 0,
        length: windowLength,
      },
      result: report,
      rawResult: null,
      confidence: "observed",
      limitations: [],
      locations: [{ kind: "artifact-path", path: artifactPath }],
    },
  );
  await writeFile(evidencePath, JSON.stringify(evidence));
  const client = await connect(true);
  const response = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: { kind: "evidence-file", path: evidencePath },
      view: {
        kind: "byte-entropy",
        collection: "blocks",
        run_boundaries_only: true,
      },
    },
  });
  expect(response.isError).not.toBe(true);
  const page = byteEntropyPageViewResultSchema.parse(
    parseEvidence(response.structuredContent).normalized_result,
  );
  expect(page.entropy.block_count).toBe(32_768);
  expect(page.items).toEqual([
    { offset: 0, length: blockSize, entropy: 0 },
    { offset: 16_383 * blockSize, length: blockSize, entropy: 0 },
    { offset: 16_384 * blockSize, length: blockSize, entropy: 8 },
    { offset: 16_385 * blockSize, length: blockSize, entropy: 0 },
    { offset: 32_767 * blockSize, length: blockSize, entropy: 0 },
  ]);
  expect(page.coverage).toEqual({
    status: "page",
    examined: 5,
    total: 5,
    next_offset: null,
    exhausted: true,
    examined_blocks: 32_768,
    matched_blocks: 5,
  });
  expect(textBytes(response.content)).toBeLessThan(4096);
});
