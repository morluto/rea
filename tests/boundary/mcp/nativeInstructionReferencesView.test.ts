import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import {
  analysisViewResultSchema,
  inspectAnalysisViewInputSchema,
} from "../../../src/domain/analysisView/analysisView.js";
import { ok } from "../../../src/domain/result.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { z } from "zod";

const provider = { id: "fixture", name: "Fixture", version: "1" };
const row = {
  source_address: "0x2000",
  target_address: "0x1000",
  type: "DATA",
  call: false,
  jump: false,
  indirect: false,
  computed: false,
  operand_index: 0,
  data: true,
  provenance: "fixture",
};
const instruction = (incoming: "rows" | "unavailable" | "not-recorded") => ({
  address: "0x1000",
  status: "data",
  procedure: null,
  architecture: "fixture",
  mode: "fixture",
  bytes: null,
  length: null,
  mnemonic: null,
  raw_disassembly: null,
  operands: [],
  flow: {
    kind: "unavailable",
    conditional: false,
    computed: false,
    direct_destinations: [],
  },
  references: [],
  ...(incoming === "rows"
    ? { incoming_references: Array.from({ length: 500 }, () => row) }
    : incoming === "unavailable"
      ? { incoming_references: null }
      : {}),
  limitations: ["static observations only"],
});

it.each(["rows", "unavailable", "not-recorded"] as const)(
  "retains and pages %s instruction references through MCP",
  async (incoming) => {
    let reads = 0;
    const session = createTestBinarySession(() => ({
      execute: async () => {
        reads++;
        return ok(createAnalysisExecution(instruction(incoming), provider));
      },
      close: async () => ok(null),
    }));
    const server = createServer(
      { kind: "session", session },
      { delivery: createToolResultDelivery(32 * 1024) },
    );
    const client = new Client({
      name: "instruction-reference-pages",
      version: "1",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      expect(
        (
          await client.callTool({
            name: "open_binary",
            arguments: { path: process.execPath },
          })
        ).isError,
      ).not.toBe(true);
      const result = await client.callTool({
        name: "inspect_native_instruction",
        arguments: { address: "0x1000" },
      });
      let source: { kind: "retained-evidence"; evidence_id: string };
      if (incoming === "rows") {
        const error = parseMcpToolError(result).error;
        expect(error.code).toBe("resource_constraint");
        const continuation = z
          .object({
            reported_limits: z.object({
              continuation: z.object({
                name: z.literal("inspect_analysis_view"),
                arguments: inspectAnalysisViewInputSchema,
              }),
            }),
          })
          .parse(error.details).reported_limits.continuation;
        expect(continuation.arguments.view).toMatchObject({
          kind: "native-instruction-references",
          collection: "incoming_references",
        });
        source = continuation.arguments.source as typeof source;
      } else {
        expect(result.isError).not.toBe(true);
        source = {
          kind: "retained-evidence",
          evidence_id: parseEvidence(result.structuredContent).evidence_id,
        };
      }
      const before = reads;
      const reply = await client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source,
          view: {
            kind: "native-instruction-references",
            collection: "incoming_references",
            offset: incoming === "rows" ? 1 : 0,
            limit: 1,
          },
        },
      });
      expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true);
      const page = analysisViewResultSchema.parse(
        parseEvidence(reply.structuredContent).normalized_result,
      );
      expect(page).toMatchObject({
        parent_evidence_id: source.evidence_id,
        instruction: { status: "data", address: "0x1000" },
      });
      if (incoming === "rows")
        expect(page).toMatchObject({
          items: {
            state: "available",
            rows: [{ source_index: 1, value: row }],
          },
          coverage: { total: 500, next_offset: 2 },
        });
      else
        expect(page).toMatchObject({
          items: { state: incoming, rows: null },
          coverage: null,
        });
      expect(reads).toBe(before);
    } finally {
      await Promise.all([client.close(), server.close()]);
      const closed = await session.close();
      if (!closed.ok) throw closed.error;
    }
  },
  90_000,
);

it("recovers the complete parent when a single reference exceeds the page budget", async () => {
  const oversized = { ...row, type: "x".repeat(1024 * 1024) };
  const parent = createEvidence(undefined, provider, {
    operation: "inspect_native_instruction",
    parameters: { address: "0x1000" },
    result: { ...instruction("rows"), incoming_references: [row, oversized] },
  });
  const session = createTestBinarySession(() => ({
    execute: async () => ok(createAnalysisExecution(null, provider)),
    close: async () => ok(null),
  }));
  const retained = session.recordEvidence(parent);
  if (!retained.ok) throw retained.error;
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "oversized-instruction-reference",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const source = {
      kind: "retained-evidence",
      evidence_id: parent.evidence_id,
    };
    const view = async (collection: string, offset: number, limit: number) =>
      client.callTool({
        name: "inspect_analysis_view",
        arguments: {
          source,
          view: {
            kind: "native-instruction-references",
            collection,
            offset,
            limit,
          },
        },
      });
    const first = await view("incoming_references", 0, 2);
    expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
    expect(
      parseEvidence(first.structuredContent).normalized_result,
    ).toMatchObject({
      items: { state: "available", rows: [{ source_index: 0, value: row }] },
      byte_limited: true,
      coverage: { total: 2, next_offset: 1, exhausted: false },
    });
    const stopped = await view("incoming_references", 1, 1);
    expect(parseMcpToolError(stopped).error).toMatchObject({
      code: "resource_constraint",
      details: { reported_limits: { parent_evidence_id: parent.evidence_id } },
    });
    const other = await view("references", 0, 1);
    expect(other.isError).not.toBe(true);
    expect(
      parseEvidence(other.structuredContent).normalized_result,
    ).toMatchObject({
      items: { state: "available", rows: [] },
      coverage: { total: 0, exhausted: true },
    });
    const bundle = await client.callTool({
      name: "get_evidence_bundle",
      arguments: {
        detail: "records",
        filters: { evidence_id: parent.evidence_id },
      },
    });
    expect(bundle.isError, JSON.stringify(bundle.content)).not.toBe(true);
    expect(bundle.structuredContent).toMatchObject({
      result: {
        records: [
          {
            evidence_id: parent.evidence_id,
            normalized_result: { incoming_references: [row, oversized] },
          },
        ],
      },
    });
  } finally {
    await Promise.all([client.close(), server.close()]);
    const closed = await session.close();
    if (!closed.ok) throw closed.error;
  }
}, 90_000);
