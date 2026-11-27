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
import { createFixtureProviderIdentity } from "../../fixtures/analysisExecution.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { completedOperationEvidence } from "../../../src/application/binary/SessionEvidenceReuse.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const validation = createMcpSchemaValidation();
afterAll(() => validation.clear());

const provider = createFixtureProviderIdentity();
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

it("reuses the retained record and exports a snapshot that carries its linked context", async () => {
  const profile = createAnalysisProfile(provider, {
    fixture: "session-limitations",
  });
  const session = new BinarySession(
    createTestProviderRouter(client, {
      resolveAnalysisProfile: () => Promise.resolve(ok({ profile })),
    }),
    new InvestigationRecords(),
    undefined,
    "reference",
  );
  try {
    const opened = await session.open(process.execPath);
    if (!opened.ok) throw opened.error;
    const result = await session.execute("inspect_native_instruction", {
      address: "0x1000",
      document: "fixture",
    });
    if (!result.ok) throw result.error;
    const context = result.value.sourceEvidence?.at(-1)?.evidence_id;
    if (context === undefined) throw new Error("Missing session context");
    // The adapter reuses the record the session retained instead of copying
    // and hashing the result again, although the execution carries a source.
    const retained =
      result.value.evidenceId === undefined
        ? undefined
        : session.evidenceForAnalysis(result.value.evidenceId);
    expect(retained?.evidence_links).toEqual([context]);
    const delivered = completedOperationEvidence(
      "inspect_native_instruction",
      { address: "0x1000", document: "fixture" },
      result.value,
      {
        target: null,
        evidenceById: (id) => session.evidenceForAnalysis(id),
      },
    );
    if (!delivered.ok) throw delivered.error;
    expect(delivered.value).toBe(retained);
    // A persisted snapshot authenticates entries against their Evidence, so
    // entries keep the referenced form; its bundle carries the linked record,
    // so a replay in another process can still resolve the reference.
    const snapshot = session.exportAnalysisSnapshot();
    if (!snapshot.ok) throw snapshot.error;
    expect(
      snapshot.value.evidence_bundle.records.find(
        (record) => record.evidence_id === context,
      )?.limitations,
    ).toEqual(SESSION);
  } finally {
    await session.close();
  }
});

it("writes the full session limitations into a decompile_all directory", async () => {
  const exportClient = (): AnalysisClient => ({
    execute: async (operation) =>
      ok(
        createAnalysisExecution(
          operation === "list_procedures"
            ? [{ address: "0x1000", value: "main" }]
            : operation === "procedure_info"
              ? null
              : "int main(void) { return 0; }",
          provider,
          { limitations: [CALL, ...SESSION], sessionLimitations: SESSION },
        ),
      ),
    close: async () => ok(null),
  });
  const session = new BinarySession(
    createTestProviderRouter(exportClient),
    new InvestigationRecords(),
    undefined,
    "reference",
  );
  const server = createServer({ kind: "session", session });
  const mcp = new Client(
    { name: "session-limitations-export", version: "1" },
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
    const output = join(
      await createTestTempDirectory("rea-session-limitations-export-"),
      "out",
    );
    const exported = await mcp.callTool({
      name: "decompile_all",
      arguments: { output_directory: output },
    });
    expect(exported.isError, JSON.stringify(exported.content)).not.toBe(true);
    // The directory outlives the session, so it keeps the text the session
    // only references.
    const index = JSON.parse(
      await readFile(join(output, "decompile-index.json"), "utf8"),
    ) as { functions: { limitations?: string[] }[] };
    const recorded = index.functions[0]?.limitations ?? [];
    expect(recorded).toEqual(expect.arrayContaining(SESSION));
    expect(recorded.join("\n")).not.toContain("linked Evidence");
    const file = await readFile(join(output, "functions", "0x1000.c"), "utf8");
    for (const entry of SESSION) expect(file).toContain(entry);
  } finally {
    await mcp.close();
    await server.close();
    await session.close();
  }
});
