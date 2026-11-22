import { describe, expect, it, vi } from "vitest";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  isJSONRPCResultResponse,
  type JSONRPCResultResponse,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { CallerAbort, OwnerCancellation } from "../domain/analysisErrorCore.js";
import { InvestigationRecords } from "../application/investigation/InvestigationRecords.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../contracts/officialToolContracts.js";
import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { forgetPendingMcpRequest } from "./EvidenceMcpServerCore.js";
import { createDeferred } from "../../tests/fixtures/binarySession.js";
import { phaseGate } from "../../tests/support/lifecycleHarness.js";
import { createToolResultDelivery } from "./toolResult.js";

const firstText = (result: {
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
}): string | undefined => {
  for (const item of result.content) {
    if (item.type === "text") return item.text;
  }
  return undefined;
};

const expectFittingSdkValidationRecovery = (result: {
  readonly isError?: boolean | undefined;
  readonly content: readonly {
    readonly type: string;
    readonly text?: string;
  }[];
}): void => {
  expect(result.isError).toBe(true);
  expect(JSON.parse(firstText(result) ?? "null")).toMatchObject({
    error: {
      code: "invalid_request",
      recovery: {
        kind: "inspect_input_contract",
        operation: "procedure_pseudo_code",
      },
      details: {
        operation: "procedure_pseudo_code",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["required"],
            reason: "missing_argument",
            expected: "string",
          }),
          expect.objectContaining({
            path: ["unexpected"],
            reason: "unknown_argument",
          }),
        ]),
      },
    },
  });
};

const expectEscapedSdkDiagnosticRetention = async (
  client: Client,
  records: InvestigationRecords,
  previousEvidenceId: string,
): Promise<void> => {
  const quotedKey = '"\\'.repeat(350);
  const quoted = await client.callTool({
    name: "procedure_pseudo_code",
    arguments: { required: "present", [quotedKey]: true },
  });
  expect(quoted.isError).toBe(true);
  expect(JSON.parse(firstText(quoted) ?? "null")).toMatchObject({
    error: {
      code: "resource_constraint",
      details: {
        reported_limits: {
          evidence_reference: { kind: "retained-evidence" },
        },
      },
    },
  });
  expect(Buffer.byteLength(JSON.stringify(quoted))).toBeLessThan(4096);
  const bundle = records.exportEvidenceBundle();
  expect(bundle.records).toHaveLength(2);
  const quotedOriginal = bundle.records.find(
    (record) => record.evidence_id !== previousEvidenceId,
  );
  expect(quotedOriginal?.raw_result).toMatchObject({
    content: [{ text: expect.stringContaining(quotedKey) }],
  });
};

describe("MCP request bookkeeping", () => {
  it("releases list, tool, and completion state when cancellation arrives", () => {
    const completion = new AbortController();
    const pendingTools = new Map([[7, "inspect_artifact"]]);
    const pendingToolLists = new Set([7]);
    const pendingCompletions = new Map([[7, completion]]);

    const cancellation = new CallerAbort("request-cancelled", "user stopped");

    forgetPendingMcpRequest(
      pendingTools,
      pendingToolLists,
      pendingCompletions,
      7,
      cancellation,
    );

    expect(pendingTools.has(7)).toBe(false);
    expect(pendingToolLists.has(7)).toBe(false);
    expect(completion.signal.reason).toBe(cancellation);
    expect(pendingCompletions.has(7)).toBe(false);
  });
});

it("passes the owned cancellation signal to a tool without an input schema", async () => {
  const records = new InvestigationRecords();
  const server = new EvidenceMcpServer(
    { name: "no-input-abort-test", version: "1" },
    { capabilities: {} },
    (evidence) => records.recordEvidence(evidence),
    createToolResultDelivery(4096),
  );
  const handler = phaseGate();
  const observed = createDeferred<unknown>();
  const finished = createDeferred<void>();
  let started = false;
  server.registerTool("held", {}, async (context) => {
    const signal = context.mcpReq.signal;
    signal.addEventListener("abort", () => observed.resolve(signal.reason), {
      once: true,
    });
    started = true;
    try {
      await handler.hold();
      return { content: [{ type: "text", text: "finished" }] };
    } finally {
      finished.resolve();
    }
  });
  const client = new Client(
    { name: "no-input-abort-client", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const serving = serveStdio(() => server, { transport: serverTransport });
  try {
    await client.connect(clientTransport);
    const controller = new AbortController();
    const pending = client
      .callTool({ name: "held" }, { signal: controller.signal })
      .catch(() => undefined);
    await handler.reached(pending, "held tool handler entry");
    controller.abort("stop no-input tool");
    await pending;
    expect(await observed.promise).toMatchObject({
      kind: "request-cancelled",
      clientReason: "stop no-input tool",
    });
  } finally {
    handler.release();
    if (started) await finished.promise;
    await Promise.all([client.close(), serving.close()]);
  }
});

it("aborts a running tool with a caller abort that keeps the client's reason", async () => {
  const records = new InvestigationRecords();
  const server = new EvidenceMcpServer(
    { name: "caller-abort-test", version: "1" },
    { capabilities: {} },
    (evidence) => records.recordEvidence(evidence),
    createToolResultDelivery(4096),
  );
  const handler = phaseGate();
  const observed = createDeferred<unknown>();
  const finished = createDeferred<void>();
  let started = false;
  server.registerTool(
    "held",
    { inputSchema: z.strictObject({}) },
    async (_input, context) => {
      const signal = context.mcpReq.signal;
      signal.addEventListener("abort", () => observed.resolve(signal.reason), {
        once: true,
      });
      started = true;
      try {
        await handler.hold();
        return { content: [{ type: "text", text: "finished" }] };
      } finally {
        finished.resolve();
      }
    },
  );
  const client = new Client(
    { name: "caller-abort-client", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const serving = serveStdio(() => server, { transport: serverTransport });
  try {
    await client.connect(clientTransport);
    const controller = new AbortController();
    const pending = client.callTool(
      { name: "held", arguments: {} },
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toBeDefined();
    await handler.reached(pending, "held tool handler entry");
    controller.abort("user stopped");
    await rejected;

    const reason = await observed.promise;
    expect(reason).toBeInstanceOf(CallerAbort);
    expect(reason).toMatchObject({
      kind: "request-cancelled",
      clientReason: "user stopped",
      name: "AbortError",
    });
  } finally {
    handler.release();
    if (started) await finished.promise;
    await Promise.all([client.close(), serving.close()]);
  }
});

it("reports owner shutdown to the handler when transport close invokes onclose", async () => {
  const records = new InvestigationRecords();
  const server = new EvidenceMcpServer(
    { name: "owner-close-test", version: "1" },
    { capabilities: {} },
    (evidence) => records.recordEvidence(evidence),
    createToolResultDelivery(4096),
  );
  const handler = phaseGate();
  const observed = createDeferred<unknown>();
  const finished = createDeferred<void>();
  let started = false;
  server.registerTool(
    "held",
    { inputSchema: z.strictObject({}) },
    async (_input, context) => {
      context.mcpReq.signal.addEventListener(
        "abort",
        () => observed.resolve(context.mcpReq.signal.reason),
        { once: true },
      );
      started = true;
      try {
        await handler.hold();
        return { content: [{ type: "text", text: "finished" }] };
      } finally {
        finished.resolve();
      }
    },
  );
  const client = new Client(
    { name: "owner-close-client", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const serving = serveStdio(() => server, { transport: serverTransport });
  try {
    await client.connect(clientTransport);
    const pending = client
      .callTool({ name: "held", arguments: {} })
      .catch(() => undefined);
    await handler.reached(pending, "held tool handler entry");
    await server.close();
    expect(await observed.promise).toBe(OwnerCancellation.ownerClosed);
    await pending;
  } finally {
    handler.release();
    if (started) await finished.promise;
    await Promise.all([client.close(), serving.close()]);
  }
});

describe("Modern protocol error delivery", () => {
  it("preserves the modern wire envelope when replacing an oversized error", async () => {
    const records = new InvestigationRecords();
    const delivery = createToolResultDelivery(16384);
    const info = { name: "wire-error-recovery", version: "1" };
    const handler = createMcpHandler(() => {
      const server = new EvidenceMcpServer(
        info,
        { capabilities: {} },
        (evidence) => records.recordEvidence(evidence),
        delivery,
      );
      server.registerTool(
        "procedure_pseudo_code",
        { inputSchema: z.strictObject({ selected: z.string() }) },
        async () => ({ content: [{ type: "text", text: "valid call" }] }),
      );
      return server;
    });
    const responses: unknown[] = [];
    const transport = new StreamableHTTPClientTransport(
      new URL("http://rea-test.invalid/mcp"),
      {
        fetch: async (url, init) => {
          const response = await handler.fetch(new Request(url, init));
          if (
            response.headers.get("content-type")?.includes("application/json")
          )
            responses.push(await response.clone().json());
          return response;
        },
      },
    );
    const client = new Client(info, {
      versionNegotiation: {
        mode: { pin: "2026-07-28" },
      },
    });
    try {
      await client.connect(transport);
      const invalidField = `unexpected_${"x".repeat(5000)}_tail`;
      const fitting = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { [invalidField]: true },
      });
      expect(fitting.isError).toBe(true);
      expect(JSON.parse(firstText(fitting) ?? "null")).toMatchObject({
        error: {
          code: "invalid_request",
          recovery: {
            kind: "inspect_input_contract",
            operation: "procedure_pseudo_code",
          },
          details: {
            issues: [{ message: expect.stringContaining(invalidField) }],
          },
        },
      });

      const recovered = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { selected: "value", ["x".repeat(20000)]: true },
      });
      expect(recovered.isError).toBe(true);
      expect(recovered.structuredContent).toBeUndefined();
      expect(JSON.parse(firstText(recovered) ?? "null")).toMatchObject({
        error: {
          code: "resource_constraint",
          details: {
            reported_limits: {
              evidence_reference: { kind: "retained-evidence" },
            },
          },
        },
      });
      expect(records.exportEvidenceBundle().records).toHaveLength(1);

      const valid = await client.callTool({
        name: "procedure_pseudo_code",
        arguments: { selected: "value" },
      });
      expect(firstText(valid)).toBe("valid call");
      const toolResponse = z.object({
        result: z.object({ content: z.array(z.unknown()) }).passthrough(),
      });
      const toolResults = responses.flatMap((response) => {
        const parsed = toolResponse.safeParse(response);
        return parsed.success ? [parsed.data.result] : [];
      });
      expect(toolResults).toHaveLength(3);
      for (const result of toolResults) {
        expect(result.resultType).toBe("complete");
        expect(result._meta).toMatchObject({
          "io.modelcontextprotocol/serverInfo": info,
        });
      }
      expect(Buffer.byteLength(JSON.stringify(toolResults[1]))).toBeLessThan(
        16384,
      );
      expect(toolResults[1]?._meta).toMatchObject({
        provenance: { untrusted_content: true, source: "analysis_target" },
      });
    } finally {
      await client.close();
      await handler.close();
    }
  });
});

describe("SDK validation error delivery", () => {
  it.each(["2025-11-25", "2026-07-28"])(
    "bounds and retains errors through the public stdio entry on %s",
    async (revision) => {
      const delivery = createToolResultDelivery(4096);
      const records = new InvestigationRecords();
      const server = new EvidenceMcpServer(
        { name: "sdk-validation-budget-test", version: "1" },
        { capabilities: {} },
        (evidence) => records.recordEvidence(evidence),
        delivery,
      );
      server.registerTool(
        "procedure_pseudo_code",
        { inputSchema: z.strictObject({ required: z.string() }) },
        async () => ({ content: [{ type: "text", text: "valid call" }] }),
      );
      const client = new Client(
        {
          name: "sdk-validation-budget-client",
          version: "1",
        },
        revision === "2026-07-28"
          ? { versionNegotiation: { mode: { pin: revision } } }
          : { supportedProtocolVersions: [revision] },
      );
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const oversizedKey = `unexpected_${"x".repeat(6000)}`;
      const serving = serveStdio(() => server, { transport: serverTransport });
      const replies: JSONRPCResultResponse[] = [];
      try {
        await client.connect(clientTransport);
        expect(client.getNegotiatedProtocolVersion()).toBe(revision);
        const receive = clientTransport.onmessage;
        clientTransport.onmessage = (message) => {
          if (isJSONRPCResultResponse(message)) replies.push(message);
          receive?.(message);
        };

        // The normal reply and SDK validation error already negotiate and decode
        // correctly before oversized recovery replaces an SDK-encoded envelope.
        const valid = await client.callTool({
          name: "procedure_pseudo_code",
          arguments: { required: "present" },
        });
        expect(valid.content).toContainEqual({
          type: "text",
          text: "valid call",
        });
        const fitting = await client.callTool({
          name: "procedure_pseudo_code",
          arguments: { unexpected: true },
        });
        expectFittingSdkValidationRecovery(fitting);

        await expect(
          client.callTool({ name: "missing_tool", arguments: {} }),
        ).rejects.toThrow(
          "Call tools/list, select an advertised tool, and retry",
        );

        const oversized = await client.callTool({
          name: "procedure_pseudo_code",
          arguments: { required: "present", [oversizedKey]: true },
        });
        expect(oversized.isError).toBe(true);
        expect(oversized.structuredContent).toBeUndefined();
        expect(oversized._meta).toEqual({
          provenance: { untrusted_content: true, source: "analysis_target" },
          ...(revision === "2026-07-28"
            ? {
                "io.modelcontextprotocol/serverInfo": {
                  name: "sdk-validation-budget-test",
                  version: "1",
                },
              }
            : {}),
        });
        expect(Buffer.byteLength(JSON.stringify(oversized))).toBeLessThan(4096);
        const oversizedError = z
          .object({
            error: z.object({
              code: z.string(),
              details: z.object({
                reported_limits: z.record(z.string(), z.unknown()),
              }),
            }),
          })
          .parse(JSON.parse(firstText(oversized) ?? "null"));
        expect(oversizedError.error.code).toBe("resource_constraint");
        const reportedLimits = oversizedError.error.details.reported_limits;
        expect(reportedLimits).toMatchObject({
          evidence_reference: {
            kind: "retained-evidence",
            evidence_id: expect.any(String),
          },
          diagnostic_truncated: true,
        });
        expect(reportedLimits).not.toHaveProperty("retention");
        const bundle = records.exportEvidenceBundle();
        expect(bundle.records).toHaveLength(1);
        expect(bundle.records[0]?.operation).toBe("mcp_tool_error");
        expect(bundle.records[0]?.raw_result).toMatchObject({
          isError: true,
          content: [
            { type: "text", text: expect.stringContaining(oversizedKey) },
          ],
        });
        const evidenceReference = z
          .object({ evidence_id: z.string() })
          .parse(reportedLimits.evidence_reference);
        expect(bundle.records[0]?.evidence_id).toBe(
          evidenceReference.evidence_id,
        );

        await expectEscapedSdkDiagnosticRetention(
          client,
          records,
          evidenceReference.evidence_id,
        );

        const recovered = await client.callTool({
          name: "procedure_pseudo_code",
          arguments: { required: "present" },
        });
        expect(recovered.content).toContainEqual({
          type: "text",
          text: "valid call",
        });
        for (const reply of replies) {
          expect(reply.result.resultType).toBe(
            revision === "2026-07-28" ? "complete" : undefined,
          );
          expect(
            Buffer.byteLength(JSON.stringify(reply)) + 1,
          ).toBeLessThanOrEqual(4096);
        }
      } finally {
        await Promise.all([client.close(), serving.close()]);
      }
    },
  );
});

const createGuidanceClientServer = async (
  toolName: string,
  inputSchema: z.ZodTypeAny,
) => {
  const delivery = createToolResultDelivery(4096);
  const records = new InvestigationRecords();
  const server = new EvidenceMcpServer(
    { name: "sdk-argument-guidance-test", version: "1" },
    { capabilities: {} },
    (evidence) => records.recordEvidence(evidence),
    delivery,
  );
  server.registerTool(toolName, { inputSchema }, async () => ({
    content: [{ type: "text", text: "valid call" }],
  }));
  const client = new Client(
    { name: "sdk-argument-guidance-client", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const serving = serveStdio(() => server, { transport: serverTransport });
  await client.connect(clientTransport);
  return {
    client,
    close: () => Promise.all([client.close(), serving.close()]),
  };
};

const officialContract = (
  name: (typeof OFFICIAL_TOOL_CONTRACTS)[number]["name"],
) => {
  const contract = OFFICIAL_TOOL_CONTRACTS.find((c) => c.name === name);
  if (contract === undefined)
    throw new Error(`Missing official contract: ${name}`);
  return contract;
};

describe("SDK argument name guidance", () => {
  it("guides procedure_pseudo_code caller from address to procedure without duplicating diagnostic", async () => {
    const session = await createGuidanceClientServer(
      "procedure_pseudo_code",
      officialContract("procedure_pseudo_code").inputSchema,
    );
    try {
      const result = await session.client.callTool({
        name: "procedure_pseudo_code",
        arguments: { address: "0x401000" },
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse(firstText(result) ?? "null");
      expect(payload.error.code).toBe("invalid_request");
      expect(payload.error.details.issues).toContainEqual(
        expect.objectContaining({
          path: ["address"],
          reason: "unknown_argument",
          expected: "procedure",
          message: expect.stringMatching(/address.*procedure/i),
        }),
      );
      expect(payload.error.remediation.action).toMatch(/procedure.*address/i);
      expect(payload.error.message).not.toContain("address");
    } finally {
      await session.close();
    }
  });

  it("guides search_strings caller from query to pattern", async () => {
    const session = await createGuidanceClientServer(
      "search_strings",
      officialContract("search_strings").inputSchema,
    );
    try {
      const result = await session.client.callTool({
        name: "search_strings",
        arguments: { query: "admin" },
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse(firstText(result) ?? "null");
      expect(payload.error.code).toBe("invalid_request");
      expect(payload.error.details.issues).toContainEqual(
        expect.objectContaining({
          path: ["query"],
          reason: "unknown_argument",
          expected: "pattern",
          message: expect.stringMatching(/query.*pattern/i),
        }),
      );
      expect(payload.error.remediation.action).toMatch(/pattern.*query/i);
    } finally {
      await session.close();
    }
  });

  it("rejects address with procedure guidance and retains unexplained key count in diagnostics", async () => {
    const session = await createGuidanceClientServer(
      "read_function_instructions",
      officialContract("read_function_instructions").inputSchema,
    );
    try {
      const result = await session.client.callTool({
        name: "read_function_instructions",
        arguments: { address: "0x401000", count: 10 },
      });
      expect(result.isError).toBe(true);
      const payload = JSON.parse(firstText(result) ?? "null");
      expect(payload.error.code).toBe("invalid_request");
      expect(payload.error.details.issues).toContainEqual(
        expect.objectContaining({
          path: ["address"],
          reason: "unknown_argument",
          expected: "procedure",
          message: expect.stringMatching(/address.*procedure/i),
        }),
      );
      expect(payload.error.details.issues).toContainEqual(
        expect.objectContaining({
          path: ["count"],
          reason: "unknown_argument",
        }),
      );
      const countIssue = payload.error.details.issues.find(
        (issue: { path: string[] }) => issue.path?.[0] === "count",
      );
      expect(payload.error.remediation.action).toMatch(/procedure.*address/i);
      expect(countIssue?.expected).toBeUndefined();
      expect(countIssue?.message).toBeUndefined();
      expect(payload.error.message).toContain("count");
    } finally {
      await session.close();
    }
  });
});

it("reuses the tool registration input projection across SDK listings", async () => {
  const server = new EvidenceMcpServer(
    { name: "input-projection-server", version: "1" },
    { capabilities: {} },
    undefined,
    createToolResultDelivery(4096),
  );
  const schema = z.strictObject({ value: z.string() });
  const standard = schema["~standard"];
  const input = vi.fn(standard.jsonSchema.input);
  Object.defineProperty(schema, "~standard", {
    value: { ...standard, jsonSchema: { ...standard.jsonSchema, input } },
  });
  server.registerTool(
    "counted_input",
    { description: "Count input projections", inputSchema: schema },
    async () => ({ content: [] }),
  );
  expect(input).toHaveBeenCalledExactlyOnceWith({ target: "draft-2020-12" });

  const client = new Client({ name: "input-projection-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const serving = serveStdio(() => server, { transport: serverTransport });
  try {
    await client.connect(clientTransport);
    const first = await client.listTools();
    expect(first.tools).toMatchObject([
      {
        name: "counted_input",
        description: "Count input projections",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ]);
    expect(input).toHaveBeenCalledTimes(1);
    expect(await client.listTools()).toEqual(first);
    expect(input).toHaveBeenCalledTimes(1);
  } finally {
    await Promise.all([client.close(), serving.close()]);
  }
});

it("skips object-root output schema projection on output=off while keeping runtime validation and legacy wrapping", async () => {
  const server = new EvidenceMcpServer(
    { name: "output-off-skip-test", version: "1" },
    { capabilities: {} },
    undefined,
    createToolResultDelivery(4096),
    undefined,
    "off",
  );
  let objectOutputCalls = 0;
  const spyObjectOutput = z.strictObject({ count: z.int() });
  const baseStandard = spyObjectOutput["~standard"];
  Object.defineProperty(spyObjectOutput, "~standard", {
    value: {
      ...baseStandard,
      jsonSchema: {
        ...baseStandard.jsonSchema,
        output: (options: unknown) => {
          objectOutputCalls += 1;
          return baseStandard.jsonSchema.output(options as never);
        },
      },
    },
  });
  server.registerTool(
    "object_tool",
    {
      inputSchema: z.strictObject({ n: z.int() }),
      outputSchema: spyObjectOutput,
    },
    async ({ n }) => ({
      content: [],
      structuredContent: n >= 0 ? { count: n } : ({ count: "bad" } as never),
    }),
  );
  const nonObjectUnionOutput = z.union([
    z.strictObject({ status: z.literal("ok") }),
    z.string(),
  ]);
  server.registerTool(
    "union_tool",
    {
      inputSchema: z.strictObject({}),
      outputSchema: nonObjectUnionOutput,
    },
    async () => ({
      content: [],
      structuredContent: { status: "ok" as const },
    }),
  );
  const client = new Client(
    { name: "output-off-client", version: "1" },
    { supportedProtocolVersions: ["2025-11-25"] },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const serving = serveStdio(() => server, { transport: serverTransport });
  try {
    await client.connect(clientTransport);
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    const listed = await client.listTools();
    expect(objectOutputCalls).toBe(0);
    for (const tool of listed.tools) expect(tool.outputSchema).toBeUndefined();

    const valid = await client.callTool({
      name: "object_tool",
      arguments: { n: 42 },
    });
    expect(valid.isError).toBeFalsy();
    expect(valid.structuredContent).toEqual({ count: 42 });

    const invalidOutput = await client.callTool({
      name: "object_tool",
      arguments: { n: -1 },
    });
    expect(invalidOutput.isError).toBe(true);

    // Non-object union root keeps 2025 legacy `{ result }` wrapping.
    const wrapped = await client.callTool({
      name: "union_tool",
      arguments: {},
    });
    expect(wrapped.isError).toBeFalsy();
    expect(wrapped.structuredContent).toEqual({ result: { status: "ok" } });
  } finally {
    await Promise.all([client.close(), serving.close()]);
  }
});
