import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  isJSONRPCErrorResponse,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type Transport,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import {
  createBinarySessionTargets,
  createDeferred,
  createTestBinarySession,
  ControllableAnalysisClient,
} from "../../tests/fixtures/binarySession.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";
import { createMcpSchemaValidation } from "../../tests/fixtures/mcpSchemaValidation.js";
import { DEFAULT_MCP_MAX_INPUT_ELEMENTS } from "../config/mcpInputBudget.js";
import { DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET } from "../config/mcpToolsListPageBudget.js";
import { CallerAbort, OwnerCancellation } from "../domain/analysisErrorCore.js";
import { InvestigationRecords } from "../application/investigation/InvestigationRecords.js";
import { withAdmittedAnalysis } from "./analysisAdmission.js";
import {
  currentMcpRequestSignal,
  ErrorEvidenceTransport,
} from "./ErrorEvidenceTransport.js";
import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import {
  currentMcpToolRequest,
  type McpToolRequest,
} from "./McpToolRequest.js";
import { createToolResultDelivery } from "./toolResult.js";

class StubTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly sent: JSONRPCMessage[] = [];
  closedCount = 0;

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.closedCount += 1;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }
}

const createUnitErrorEvidenceTransport = (inner = new StubTransport()) => {
  const delivery = createToolResultDelivery(4096);
  const transport = new ErrorEvidenceTransport(
    inner,
    undefinedRecord(),
    () => delivery,
    () => undefined,
    { budgetBytes: 4096 },
    DEFAULT_MCP_MAX_INPUT_ELEMENTS,
    new Set(),
    DEFAULT_MCP_TOOLS_LIST_PAGE_BUDGET,
    () => ({ tools: [], discoveryAvailable: false }),
  );
  return { inner, transport };
};

const undefinedRecord = () => () => undefined;

const waitForMessages = (
  messages: readonly JSONRPCMessage[],
  predicate: (message: JSONRPCMessage) => boolean,
  label: string,
  signal?: AbortSignal,
): Promise<JSONRPCMessage> =>
  new Promise((resolve, reject) => {
    const existing = messages.find(predicate);
    if (existing !== undefined) {
      resolve(existing);
      return;
    }
    const deadline = setTimeout(() => {
      clearInterval(poll);
      reject(
        new Error(
          `Timed out waiting for ${label}; saw: ${JSON.stringify(messages)}`,
        ),
      );
    }, 3000);
    const poll = setInterval(() => {
      const matched = messages.find(predicate);
      if (matched !== undefined) {
        clearInterval(poll);
        clearTimeout(deadline);
        resolve(matched);
      }
    }, 5);
    signal?.addEventListener(
      "abort",
      () => {
        clearInterval(poll);
        clearTimeout(deadline);
        reject(new Error("Aborted waiting for JSON-RPC message"));
      },
      { once: true },
    );
  });

const cleanupSessions: { close: () => Promise<unknown> }[] = [];

afterEach(async () => {
  await Promise.all(cleanupSessions.splice(0).map((item) => item.close()));
});

it("rejects duplicate in-flight tools/call ids without deadlocking BinarySession", async () => {
  const [firstTarget] = await createBinarySessionTargets();
  const session = createTestBinarySession(
    () => new ControllableAnalysisClient(),
  );
  cleanupSessions.push(session);
  const opened = await session.open(firstTarget);
  expect(opened.ok).toBe(true);

  const records = new InvestigationRecords();
  const server = new EvidenceMcpServer(
    { name: "duplicate-id-session-test", version: "1" },
    { capabilities: {} },
    (evidence) => records.recordEvidence(evidence),
    createToolResultDelivery(4096),
  );
  const gate = phaseGate();
  let handlerCalls = 0;
  const admitted = withAdmittedAnalysis({ kind: "session", session });
  server.registerTool(
    "admitted_held",
    { inputSchema: z.strictObject({}) },
    async (_input, context) => {
      handlerCalls += 1;
      const result = await admitted(
        "admitted_held",
        context.mcpReq.signal,
        async () => {
          await gate.hold();
          return "finished";
        },
      );
      return {
        content: [
          {
            type: "text",
            text: result.ok ? result.value : result.error.message,
          },
        ],
      };
    },
  );

  const client = new Client(
    { name: "duplicate-id-client", version: "1" },
    {
      jsonSchemaValidator: createMcpSchemaValidation(),
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const serving = serveStdio(() => server, { transport: serverTransport });
  try {
    await client.connect(clientTransport);
    const wireMessages: JSONRPCMessage[] = [];
    const sdkOnMessage = clientTransport.onmessage;
    clientTransport.onmessage = (message, extra) => {
      wireMessages.push(message);
      if (!("id" in message && (message.id === 1 || message.id === "1")))
        sdkOnMessage?.(message, extra);
    };

    const toolCallParams = {
      name: "admitted_held",
      arguments: {},
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    };
    const reachedWatch = new AbortController();
    const unexpectedError = waitForMessages(
      wireMessages,
      (message) =>
        isJSONRPCErrorResponse(message) &&
        message.id === 1 &&
        message.error.code !== -32600,
      "unexpected error before handler",
      reachedWatch.signal,
    );
    void unexpectedError.catch(() => undefined);
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: toolCallParams,
    });
    await gate.reached(unexpectedError, "admitted_held first handler entry");
    reachedWatch.abort();

    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: toolCallParams,
    });

    const duplicateError = await waitForMessages(
      wireMessages,
      (message) => isJSONRPCErrorResponse(message) && message.id === 1,
      "duplicateError (-32600)",
    );
    expect(isJSONRPCErrorResponse(duplicateError)).toBe(true);
    if (isJSONRPCErrorResponse(duplicateError))
      expect(duplicateError.error.code).toBe(-32600);
    expect(handlerCalls).toBe(1);

    gate.release();

    const settledFirstReply = await waitForMessages(
      wireMessages,
      (message) => isJSONRPCResultResponse(message) && message.id === 1,
      "settledFirstReply",
    );
    expect(isJSONRPCResultResponse(settledFirstReply)).toBe(true);
    if (isJSONRPCResultResponse(settledFirstReply))
      expect(settledFirstReply.result).toMatchObject({
        content: [{ type: "text", text: "finished" }],
      });

    // Closing BinarySession runs #drainCalls() and must settle cleanly.
    await expect(session.close()).resolves.toMatchObject({ ok: true });

    // Reusing id 1 after completion succeeds rather than staying blocked.
    const reopen = await session.open(firstTarget);
    expect(reopen.ok).toBe(true);
    await clientTransport.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: toolCallParams,
    });
    const firstIndex = wireMessages.indexOf(settledFirstReply);
    const reuseReply = await waitForMessages(
      wireMessages,
      (message) =>
        isJSONRPCResultResponse(message) &&
        message.id === 1 &&
        wireMessages.indexOf(message) > firstIndex,
      "reuseReply",
    );
    expect(isJSONRPCResultResponse(reuseReply)).toBe(true);
    expect(handlerCalls).toBe(2);
  } finally {
    gate.release();
    await Promise.all([client.close(), serving.close()]);
  }
});

it("rejects duplicate tools/list and completion/complete ids and allows distinct or cancelled ids", async () => {
  const { inner, transport } = createUnitErrorEvidenceTransport();
  const dispatchedSignals: {
    readonly completionSignal?: AbortSignal | undefined;
    readonly request?: McpToolRequest | undefined;
  }[] = [];
  transport.onmessage = (message) => {
    if (!isJSONRPCRequest(message)) return;
    dispatchedSignals.push({
      completionSignal: currentMcpRequestSignal(),
      request: currentMcpToolRequest(),
    });
  };

  inner.onmessage?.({
    jsonrpc: "2.0",
    id: 2,
    method: "completion/complete",
    params: {
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "a", value: "" },
    },
  });
  const firstSignal = dispatchedSignals[0]?.completionSignal;
  expect(firstSignal?.aborted).toBe(false);

  // Duplicate id 2 (even across methods) is rejected with -32600 without aborting active work.
  inner.onmessage?.({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  await Promise.resolve();

  expect(dispatchedSignals).toHaveLength(1);
  expect(firstSignal?.aborted).toBe(false);
  expect(inner.sent).toHaveLength(1);
  expect(inner.sent[0]).toMatchObject({
    jsonrpc: "2.0",
    id: 2,
    error: { code: -32600 },
  });

  // Distinct string id "2" is allowed alongside numeric 2.
  inner.onmessage?.({
    jsonrpc: "2.0",
    id: "2",
    method: "tools/list",
    params: {},
  });
  expect(dispatchedSignals).toHaveLength(2);

  // Cancelling id 2 aborts its signal and releases the id for reuse.
  inner.onmessage?.({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 2, reason: "user abort" },
  });
  expect(firstSignal?.aborted).toBe(true);

  inner.onmessage?.({
    jsonrpc: "2.0",
    id: 2,
    method: "completion/complete",
    params: {
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "a", value: "next" },
    },
  });
  expect(dispatchedSignals).toHaveLength(3);
  expect(dispatchedSignals[2]?.completionSignal).not.toBe(firstSignal);
  expect(dispatchedSignals[2]?.completionSignal?.aborted).toBe(false);
});

it("matches McpToolRequest by identity in send() when an id is cancelled and reused", async () => {
  const { inner, transport } = createUnitErrorEvidenceTransport();
  const contexts: {
    readonly req: McpToolRequest;
    readonly finish: ReturnType<typeof createDeferred<void>>;
  }[] = [];

  transport.onmessage = (message) => {
    const req = currentMcpToolRequest();
    if (req === undefined || !("id" in message) || message.id !== 9) return;
    const entry = { req, finish: createDeferred<void>() };
    contexts.push(entry);
    if (req.tool === "alpha") {
      req.validation = {
        issues: [
          {
            code: "invalid_type",
            expected: "string",
            path: ["target"],
            message: "Invalid input: expected string, received number",
          },
        ],
        input: { target: 1 },
      };
      void entry.finish.promise.then(() =>
        transport.send({
          jsonrpc: "2.0",
          id: 9,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: "Input validation error: Invalid arguments for tool alpha: target: Invalid input: expected string, received number",
              },
            ],
          },
        }),
      );
    }
  };

  inner.onmessage?.({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "alpha", arguments: { target: 1 } },
  });
  expect(contexts).toHaveLength(1);
  const reqA = contexts[0]!;

  // Cancel reqA and reuse id 9 for reqB before reqA publishes its late response.
  inner.onmessage?.({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 9, reason: "superseded" },
  });
  inner.onmessage?.({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "beta", arguments: {} },
  });
  expect(contexts).toHaveLength(2);
  const reqB = contexts[1]!;

  reqA.finish.resolve();
  await new Promise((resolve) => setTimeout(resolve, 10));

  // reqA must publish using reqA's tool/validation and keep reqB active.
  expect(inner.sent).toHaveLength(1);
  const replyText =
    isJSONRPCResultResponse(inner.sent[0]!) &&
    Array.isArray(inner.sent[0].result["content"])
      ? (inner.sent[0].result["content"][0] as { text?: string }).text
      : undefined;
  expect(replyText).toContain('"operation":"alpha"');
  expect(reqB.req.cancellation.signal.aborted).toBe(false);

  // Duplicate id 9 must still be rejected while reqB is active.
  inner.onmessage?.({
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: { name: "gamma", arguments: {} },
  });
  await Promise.resolve();
  expect(contexts).toHaveLength(2);
  expect(inner.sent[1]).toMatchObject({
    jsonrpc: "2.0",
    id: 9,
    error: { code: -32600 },
  });
});

it("cancels all active McpToolRequest instances on both close() and closed()", async () => {
  const first = createUnitErrorEvidenceTransport();
  const activeRequests: McpToolRequest[] = [];
  first.transport.onmessage = () => {
    const req = currentMcpToolRequest();
    if (req !== undefined) activeRequests.push(req);
  };

  first.inner.onmessage?.({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: { name: "t1", arguments: {} },
  });
  first.inner.onmessage?.({
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: { name: "t2", arguments: {} },
  });
  expect(activeRequests).toHaveLength(2);

  await first.transport.close();
  for (const req of activeRequests) {
    expect(req.cancellation.signal.aborted).toBe(true);
    expect(req.cancellation.signal.reason).toBe(OwnerCancellation.ownerClosed);
  }

  const second = createUnitErrorEvidenceTransport();
  const disconnectedRequests: McpToolRequest[] = [];
  second.transport.onmessage = () => {
    const req = currentMcpToolRequest();
    if (req !== undefined) disconnectedRequests.push(req);
  };
  second.inner.onmessage?.({
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: { name: "t3", arguments: {} },
  });
  second.inner.onclose?.();
  expect(disconnectedRequests[0]?.cancellation.signal.aborted).toBe(true);
  expect(disconnectedRequests[0]?.cancellation.signal.reason).toBeInstanceOf(
    CallerAbort,
  );
});

it("preserves a replacement request when a suspended send() settles after cancellation and ID reuse", async () => {
  const gate = phaseGate();
  const inner = new StubTransport();
  const baseSend = inner.send.bind(inner);
  let holdFirstSend = true;
  inner.send = async (message) => {
    if (
      holdFirstSend &&
      isJSONRPCResultResponse(message) &&
      message.id === 15
    ) {
      holdFirstSend = false;
      await gate.hold();
    }
    await baseSend(message);
  };
  const { transport } = createUnitErrorEvidenceTransport(inner);

  const signals: {
    readonly req?: McpToolRequest | undefined;
    readonly completion?: AbortSignal | undefined;
  }[] = [];
  let pendingSend: Promise<void> | undefined;
  transport.onmessage = (message) => {
    if (!isJSONRPCRequest(message)) return;
    const req = currentMcpToolRequest();
    signals.push({ req, completion: currentMcpRequestSignal() });
    if (
      "id" in message &&
      message.id === 15 &&
      req !== undefined &&
      pendingSend === undefined
    ) {
      pendingSend = transport.send({
        jsonrpc: "2.0",
        id: 15,
        result: { content: [{ type: "text", text: "stale-A" }] },
      });
    }
  };

  inner.onmessage?.({
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: { name: "held_in_send", arguments: {} },
  });
  await gate.reached(pendingSend!, "ErrorEvidenceTransport mid-send delivery");

  // While A is awaiting inner.send(), cancel id 15 and start B (completion/complete) with id 15.
  inner.onmessage?.({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 15, reason: "superseded mid-send" },
  });
  inner.onmessage?.({
    jsonrpc: "2.0",
    id: 15,
    method: "completion/complete",
    params: {
      ref: { type: "ref/prompt", name: "p" },
      argument: { name: "a", value: "active" },
    },
  });
  const completionB = signals[1]?.completion;
  expect(completionB?.aborted).toBe(false);

  // Finish A's suspended send(): its finally must NOT clear or abort B.
  gate.release();
  await pendingSend;

  expect(completionB?.aborted).toBe(false);

  // Duplicate id 15 must still be rejected while B is in flight.
  inner.onmessage?.({
    jsonrpc: "2.0",
    id: 15,
    method: "tools/list",
    params: {},
  });
  await Promise.resolve();
  expect(signals).toHaveLength(2);
  expect(
    inner.sent.some(
      (m) =>
        isJSONRPCErrorResponse(m) && m.id === 15 && m.error.code === -32600,
    ),
  ).toBe(true);

  // Settling B releases id 15 for subsequent reuse.
  await transport.send({
    jsonrpc: "2.0",
    id: 15,
    result: { completion: { values: [] } },
  });
  inner.onmessage?.({
    jsonrpc: "2.0",
    id: 15,
    method: "tools/list",
    params: {},
  });
  expect(signals).toHaveLength(3);
});
