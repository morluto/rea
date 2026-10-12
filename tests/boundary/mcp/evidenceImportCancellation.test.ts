import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { createServer } from "../../../src/server/createServer.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { OwnedFileHandle } from "../../../src/filesystem/OwnedFileHandle.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("keeps the complete session unchanged after SDK import cancellation and permits a retry", async () => {
  const root = await createTestTempDirectory("rea-mcp-import-cancel-");
  const path = join(root, "bundle.json");
  const session = createTestBinarySession(() => {
    throw new Error("Evidence import must not start a binary provider");
  });
  const provider = { id: "fixture", name: "Fixture", version: "1" };
  const existing = createEvidence(undefined, provider, {
    operation: "existing_observation",
    parameters: {},
    result: { retained: true },
  });
  const recorded = session.recordEvidence(existing);
  if (!recorded.ok) throw recorded.error;
  const imported = createEvidence(undefined, provider, {
    operation: "imported_observation",
    parameters: {},
    result: { retained: "雪😀" },
  });
  const bundle = createEvidenceBundle([imported]);
  // Valid whitespace crosses the streaming threshold without a large JSON tree.
  await writeFile(path, " ".repeat(9 * 1024 * 1024) + JSON.stringify(bundle));
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "evidence-import-cancellation",
    version: "1",
  });
  const controller = new AbortController();
  onTestFinished(async () => {
    controller.abort();
    vi.restoreAllMocks();
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const unknown = await client.callTool({
    name: "record_unknown",
    arguments: {
      question: "Which boundary remains unknown?",
      domain: "fixture",
      severity: "medium",
      required_authority: null,
      required_confidence: "derived",
      required_environment: null,
      recommended_probes: [],
      relationships: [],
    },
  });
  expect(unknown.isError, JSON.stringify(unknown)).not.toBe(true);
  const before = session.exportEvidenceBundle();

  let resolveDispatched: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => {
    resolveDispatched = resolve;
  });
  const send = clientTransport.send.bind(clientTransport);
  vi.spyOn(clientTransport, "send").mockImplementation(
    async (message, ...args) => {
      await send(message, ...args);
      if ("method" in message && message.method === "tools/call")
        resolveDispatched?.();
    },
  );
  let resolveCompleted: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => {
    resolveCompleted = resolve;
  });
  let settledResult: unknown;
  const deliver = ToolResultDelivery.prototype.toCallToolResult;
  vi.spyOn(ToolResultDelivery.prototype, "toCallToolResult").mockImplementation(
    function (this: ToolResultDelivery, result, contract) {
      const reply = deliver.call(this, result, contract);
      if (contract.name === "import_evidence_bundle") {
        settledResult = result;
        resolveCompleted?.();
      }
      return reply;
    },
  );
  const cancellation = client
    .callTool(
      { name: "import_evidence_bundle", arguments: { path } },
      { signal: controller.signal },
    )
    .then(
      () => "completed",
      (error: unknown) => error,
    );
  await dispatched;
  // The real SDK ping completes while the dispatched file reader awaits I/O.
  await client.ping();
  controller.abort(new Error("SDK import cancellation verification"));
  expect(await cancellation).toMatchObject({
    message: expect.stringContaining("SDK import cancellation verification"),
  });
  // Observe handler settlement, not just the client's local rejection.
  await completed;
  expect(session.exportEvidenceBundle()).toEqual(before);
  expect(settledResult).toMatchObject({
    ok: false,
    error: expect.any(AnalysisCancelledError),
  });
  await client.ping();
  const retry = await client.callTool({
    name: "import_evidence_bundle",
    arguments: { path },
  });
  expect(retry.isError, JSON.stringify(retry)).not.toBe(true);
  expect(retry.structuredContent).toMatchObject({
    result: {
      imported: 1,
      unknowns_added: 0,
      total: before.records.length + 1,
    },
  });
  const after = session.exportEvidenceBundle();
  expect(after.unknowns).toEqual(before.unknowns);
  expect(after.records).toHaveLength(before.records.length + 1);
  expect(after.records).toEqual(
    expect.arrayContaining([...before.records, imported]),
  );
  await client.ping();
});

it("retains a failed import close in the server scope through SDK error projection", async () => {
  const root = await createTestTempDirectory("rea-mcp-import-close-");
  const path = join(root, "bundle.json");
  const session = createTestBinarySession(() => {
    throw new Error("Evidence import must not start a binary provider");
  });
  const provider = { id: "fixture", name: "Fixture", version: "1" };
  const existing = createEvidence(undefined, provider, {
    operation: "existing_observation",
    parameters: {},
    result: { retained: true },
  });
  const imported = createEvidence(undefined, provider, {
    operation: "imported_observation",
    parameters: {},
    result: { retained: "close failure" },
  });
  const recorded = session.recordEvidence(existing);
  if (!recorded.ok) throw recorded.error;
  await writeFile(path, JSON.stringify(createEvidenceBundle([imported])));

  let allowClose = false;
  let retainedOwner: OwnedFileHandle | undefined;
  const originalClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementation(async function (this: OwnedFileHandle) {
      retainedOwner ??= this;
      if (!allowClose) throw new Error("persistent file close failure");
      return originalClose.call(this);
    });

  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "evidence-import-close-failure",
    version: "1",
  });
  onTestFinished(async () => {
    allowClose = true;
    close.mockRestore();
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const before = session.exportEvidenceBundle();

  const result = await client.callTool({
    name: "import_evidence_bundle",
    arguments: { path },
  });
  expect(result.isError).toBe(true);
  expect(session.exportEvidenceBundle()).toEqual(before);
  expect(retainedOwner).toBeDefined();
  expect(retainedOwner?.handle.fd).toBeGreaterThanOrEqual(0);

  await client.close();
  await expect(server.close()).rejects.toThrow("REA session cleanup failed");
  expect(retainedOwner?.handle.fd).toBeGreaterThanOrEqual(0);
  allowClose = true;
  close.mockRestore();
  await server.close();
  expect(retainedOwner?.handle.fd).toBe(-1);
  await session.close();
});

it("retries a transient import close failure before admitting the bundle", async () => {
  const root = await createTestTempDirectory("rea-mcp-import-close-retry-");
  const path = join(root, "bundle.json");
  const session = createTestBinarySession(() => {
    throw new Error("Evidence import must not start a binary provider");
  });
  const imported = createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      operation: "imported_observation",
      parameters: {},
      result: { retained: "retry succeeded" },
    },
  );
  await writeFile(path, JSON.stringify(createEvidenceBundle([imported])));

  const originalClose = OwnedFileHandle.prototype.close;
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockImplementationOnce(async () => {
      throw new Error("one transient file close failure");
    });
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "evidence-import-close-retry",
    version: "1",
  });
  onTestFinished(async () => {
    close.mockRestore();
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: "import_evidence_bundle",
    arguments: { path },
  });
  close.mockRestore();
  expect(result.isError).not.toBe(true);
  expect(session.exportEvidenceBundle().records).toContainEqual(imported);
  await client.ping();
});
