import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createAnalysisExecution } from "../../../src/ports/AnalysisProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import type { AnalysisClient } from "../../../src/ports/AnalysisProvider.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const validation = createMcpSchemaValidation();
afterAll(() => validation.clear());

const provider = { id: "fixture", name: "Fixture", version: "1" };
const SESSION = [
  "Fixture session limitation: auto-analysis completed before results.",
  "Fixture session limitation: closing discards metadata edits.",
];
const CALL = "Fixture call limitation: static observations only.";

const instruction = (address: string) => ({
  address,
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
  limitations: [],
});

const client = (): AnalysisClient => ({
  execute: async (_operation, parameters) =>
    ok(
      createAnalysisExecution(
        instruction(String((parameters as { address: string }).address)),
        provider,
        { limitations: [CALL, ...SESSION], sessionLimitations: SESSION },
      ),
    ),
  close: async () => ok(null),
});

it("states persistent-session limitations once in a record each result links", async () => {
  const session = new BinarySession(
    createTestProviderRouter(client),
    new InvestigationRecords(),
    undefined,
    "reference",
  );
  const server = createServer({ kind: "session", session });
  const mcp = new Client(
    { name: "session-limitations", version: "1" },
    { jsonSchemaValidator: validation },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    const opened = await mcp.callTool({
      name: "open_binary",
      arguments: { path: process.execPath },
    });
    expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
    const read = async (address: string) => {
      const response = await mcp.callTool({
        name: "inspect_native_instruction",
        arguments: { address },
      });
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
      return parseEvidence(response.structuredContent);
    };

    const first = await read("0x1000");
    const second = await read("0x1004");
    const [context] = first.evidence_links;
    if (context === undefined) throw new Error("Missing session context link");
    for (const result of [first, second]) {
      // Each result keeps its own caveat and one reference to the shared record.
      expect(result.limitations).toHaveLength(2);
      expect(result.limitations[0]).toBe(CALL);
      expect(result.limitations[1]).toContain(context);
      expect(result.limitations.join("\n")).not.toContain(SESSION[0]);
      expect(result.evidence_links).toEqual([context]);
    }

    // The referenced text stays reachable through the session ledger.
    const bundle = await mcp.callTool({
      name: "get_evidence_bundle",
      arguments: { detail: "records", filters: { evidence_id: context } },
    });
    expect(bundle.isError, JSON.stringify(bundle.content)).not.toBe(true);
    const delivered = JSON.stringify(bundle.structuredContent);
    for (const entry of SESSION) expect(delivered).toContain(entry);

    // An exported bundle carries the record its results link.
    const path = join(
      await createTestTempDirectory("rea-session-limitations-"),
      "bundle.json",
    );
    const exported = await mcp.callTool({
      name: "export_evidence_bundle",
      arguments: { path },
    });
    expect(exported.isError, JSON.stringify(exported.content)).not.toBe(true);
    const records = (
      JSON.parse(await readFile(path, "utf8")) as { records: unknown[] }
    ).records.map(parseEvidence);
    expect(
      records.find((record) => record.evidence_id === context)?.limitations,
    ).toEqual(SESSION);
  } finally {
    await mcp.close();
    await server.close();
    await session.close();
  }
});

it("keeps shared limitations inline in a one-call session", async () => {
  const session = new BinarySession(createTestProviderRouter(client));
  try {
    const opened = await session.open(process.execPath);
    if (!opened.ok) throw opened.error;
    const result = await session.execute("inspect_native_instruction", {
      address: "0x1000",
    });
    if (!result.ok) throw result.error;
    expect(result.value.limitations).toEqual([CALL, ...SESSION]);
    expect(result.value.sourceEvidence).toBeUndefined();
  } finally {
    await session.close();
  }
});
