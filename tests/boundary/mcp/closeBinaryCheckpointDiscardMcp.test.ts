import { dirname, join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { expect, it, vi } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  retainCloseOutcome,
  type EngineCloseReport,
} from "../../../src/domain/engineCloseReport.js";
import { err, ok } from "../../../src/domain/result.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { connectGhidraMcp } from "./ghidraMcpHarness.js";
import type { AnalysisProvider } from "../../../src/ports/AnalysisProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  createBinarySessionTargets,
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { ProcessCaptureResourceScope } from "../../../src/process/capture/ProcessCaptureLifecycle.js";

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
        unsavedCloseReport: () => (reported ? null : discarded),
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

const connected = async (provider: AnalysisProvider) => {
  const targets = await createBinarySessionTargets();
  const session = createTestBinarySession(provider);
  const server = createServer({ kind: "session", session });
  const client = new Client(
    { name: "close-binary-discard-paths", version: "1" },
    { jsonSchemaValidator: createMcpSchemaValidation() },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name: string, arguments_: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: arguments_ })) as CallToolResult;
  return {
    targets,
    call,
    dispose: () =>
      Promise.allSettled([client.close(), server.close(), session.close()]),
  };
};

it("refuses to replace a session whose edits would be released unsaved, until close_binary reports it", async () => {
  const { targets, call, dispose } = await connected(discardingProvider());
  const [first, second] = targets;
  try {
    expect((await call("open_binary", { path: first })).isError).not.toBe(true);
    expect(
      (await call("address_name", { address: "0x1000" })).isError,
    ).not.toBe(true);
    const refused = await call("open_binary", { path: second });
    expect(refused.isError).toBe(true);
    expect(parseMcpToolError(refused).error).toMatchObject({
      code: "capability_unavailable",
      remediation: {
        action: expect.stringMatching(/^Call close_binary first/),
      },
    });
    // The refused open kept the session and its engine.
    expect(
      (await call("address_name", { address: "0x1000" })).isError,
    ).not.toBe(true);
    const closed = await call("close_binary", {});
    expect(
      toolContract("close_binary").outputSchema.parse(closed.structuredContent)
        .result,
    ).toEqual(discarded);
    expect((await call("open_binary", { path: second })).isError).not.toBe(
      true,
    );
  } finally {
    await dispose();
  }
});

it("reports released edits on a close whose process-capture cleanup fails", async () => {
  const { targets, call, dispose } = await connected(discardingProvider());
  const cleanup = vi
    .spyOn(ProcessCaptureResourceScope.prototype, "retryCleanup")
    .mockRejectedValueOnce(new Error("Process cleanup failed"));
  try {
    await call("open_binary", { path: targets[0] });
    await call("address_name", { address: "0x1000" });
    const failed = await call("close_binary", {});
    expect(failed.isError).toBe(true);
    expect(
      parseMcpToolError(failed).error.details?.partial_observation,
    ).toEqual(discarded);
    cleanup.mockRestore();
    const retried = await call("close_binary", {});
    expect(retried.structuredContent).toEqual({ result: null });
  } finally {
    cleanup.mockRestore();
    await dispose();
  }
});

it("reports a GhidraProvider close's discard through its deferred client, on success and on a cleanup failure", async () => {
  const closes = [
    // The JVM stopped and released the edits, then a runtime root remained.
    err(
      retainCloseOutcome(
        new ProviderCleanupError("ghidra", ["/runtime/root"], {
          reason: "runtime root removal denied",
        }),
        discarded,
      ),
    ),
    ok(null),
    ok(discarded),
  ];
  const harness = await connectGhidraMcp(
    "close-binary-ghidra-discard",
    undefined,
    {
      close: () => Promise.resolve(closes.shift() ?? ok(null)),
    },
  );
  const call = (name: string, arguments_: Record<string, unknown>) =>
    harness.mcp.callTool({
      name,
      arguments: arguments_,
    }) as Promise<CallToolResult>;
  try {
    // The engine starts with the first analysis, not at open.
    expect(
      (await call("address_name", { address: "0x401000" })).isError,
    ).not.toBe(true);
    const failed = await call("close_binary", {});
    expect(failed.isError).toBe(true);
    expect(
      parseMcpToolError(failed).error.details?.partial_observation,
    ).toEqual(discarded);
    // The retry releases the rest and does not report the discard again.
    expect((await call("close_binary", {})).structuredContent).toEqual({
      result: null,
    });

    await call("open_binary", { path: process.execPath });
    await call("address_name", { address: "0x401000" });
    const closed = await call("close_binary", {});
    expect(
      toolContract("close_binary").outputSchema.parse(closed.structuredContent)
        .result,
    ).toEqual(discarded);
  } finally {
    await harness.close();
  }
});
