import { dirname, join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import type { EngineCloseReport } from "../../../src/domain/engineCloseReport.js";
import { ok } from "../../../src/domain/result.js";
import type { AnalysisProvider } from "../../../src/ports/AnalysisProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";

const discarded: EngineCloseReport = {
  checkpoint: {
    status: "discarded",
    reason: "superseded",
    directory: "/checkpoints/target",
  },
};

/** An engine whose next close releases edits a superseded save refused. */
const discardingProvider = (): AnalysisProvider => {
  const provider = createCacheProvider([]);
  return {
    ...provider,
    createClient: (...args) => {
      const client = provider.createClient(...args);
      let reported = false;
      return {
        ...client,
        close: () => {
          const report = reported ? null : discarded;
          reported = true;
          return Promise.resolve(ok(report));
        },
      };
    },
  };
};

it("reports a close that released refused checkpoint edits, with and without a snapshot", async () => {
  const [target] = await createBinarySessionTargets();
  const session = createTestBinarySession(discardingProvider());
  const server = createServer({ kind: "session", session });
  const client = new Client(
    { name: "close-binary-discard", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const call = async (name: string, arguments_: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent;
  };
  const closeResult = (value: unknown) =>
    toolContract("close_binary").outputSchema.parse(value).result;
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // The engine starts with the first analysis, not at open.
    await call("open_binary", { path: target });
    await call("address_name", { address: "0x1000" });
    expect(closeResult(await call("close_binary", {}))).toEqual(discarded);

    // A snapshot saved before the close keeps its receipt beside the report.
    await call("open_binary", { path: target });
    await call("address_name", { address: "0x1000" });
    const snapshot = join(dirname(target), "snapshot.json");
    expect(
      closeResult(await call("close_binary", { snapshot_path: snapshot })),
    ).toMatchObject({ path: snapshot, ...discarded });
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});

it("keeps an ordinary close result null", async () => {
  const [target] = await createBinarySessionTargets();
  const session = createTestBinarySession(createCacheProvider([]));
  const server = createServer({ kind: "session", session });
  const client = new Client(
    { name: "close-binary-null", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({ name: "open_binary", arguments: { path: target } });
    const closed = await client.callTool({
      name: "close_binary",
      arguments: {},
    });
    expect(closed.structuredContent).toEqual({ result: null });
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});
