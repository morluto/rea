import { createServer } from "node:http";
import { withVerifierCleanup } from "../../scripts/lib/verifier-cleanup.mjs";
import { startJebMcpFixture } from "../../tests/fixtures/jebMcp.js";
import {
  phaseGate,
  settledCause,
} from "../../tests/support/lifecycleHarness.js";
import { testWaitDeadline } from "../../tests/support/testWait.js";
import { describe, expect, it, vi } from "vitest";

import {
  decodeJebToolResult,
  createStreamableHttpJebMcpConnection,
} from "./JebMcpConnection.js";
import {
  AnalysisCancelledError,
  AnalysisProtocolError,
  OwnerCancellation,
} from "../domain/analysisErrorCore.js";

describe("decodeJebToolResult", () => {
  it("passes refusal envelopes through so the provider preserves the engine reason", () => {
    expect(
      decodeJebToolResult({
        isError: true,
        structuredContent: {
          success: false,
          message: "The decompilation failed because the item is missing",
        },
      }),
    ).toEqual({
      success: false,
      message: "The decompilation failed because the item is missing",
    });
  });

  it.each([
    [
      "structured content",
      {
        isError: true,
        structuredContent: {
          success: true,
          input_files: [],
          units: [],
        },
      },
    ],
    [
      "JSON text",
      {
        isError: true,
        content: [{ type: "text", text: '{"success":true}' }],
      },
    ],
  ] as const)("rejects error-marked success in %s", (_source, result) => {
    expect(() => decodeJebToolResult(result)).toThrow(AnalysisProtocolError);
  });

  it("preserves an explicit JEB failure envelope returned as JSON text", () => {
    expect(
      decodeJebToolResult({
        isError: true,
        content: [
          { type: "text", text: '{"success":false,"message":"missing"}' },
        ],
      }),
    ).toEqual({ success: false, message: "missing" });
  });

  it("decodes a single JSON text block", () => {
    expect(
      decodeJebToolResult({
        content: [
          { type: "text", text: '{"success":true,"text":"int x(){}"}' },
        ],
      }),
    ).toEqual({ success: true, text: "int x(){}" });
  });

  it.each(["plain observation", '{"success":true,"text":"int x('])(
    "rejects success text that is not the declared JSON envelope: %s",
    (text) => {
      expect(
        () => decodeJebToolResult({ content: [{ type: "text", text }] }),
        "malformed or truncated JSON is never decoded as an observed string",
      ).toThrow(/JEB MCP returned malformed JSON text/u);
    },
  );

  it("rejects unparseable error text as a protocol failure with the engine text", () => {
    expect(() =>
      decodeJebToolResult({
        isError: true,
        content: [{ type: "text", text: "engine exploded" }],
      }),
    ).toThrow(/engine exploded/);
  });

  it("rejects contentless results instead of inventing an observation", () => {
    expect(() => decodeJebToolResult({ content: [] })).toThrow(
      AnalysisProtocolError,
    );
  });
});

it("refuses HTTP redirects before sending requests to another endpoint", async () => {
  let followed = false;
  const server = createServer((request, response) => {
    if (request.url === "/redirected") followed = true;
    request.resume();
    response.writeHead(307, { Location: "/redirected" });
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected TCP listener");
  const connection = createStreamableHttpJebMcpConnection(
    new URL(`http://127.0.0.1:${address.port}/mcp`),
  );
  try {
    await expect(connection.connect()).rejects.toThrow();
    expect(followed).toBe(false);
  } finally {
    await connection.close();
    await new Promise<void>((resolve, reject) =>
      server.close((cause) =>
        cause === undefined ? resolve() : reject(cause),
      ),
    );
  }
});

it("accepts a tool reply beyond the SDK default under the selected timeout", async () => {
  const observation = { success: true, text: "finished" };
  const fixture = await startJebMcpFixture(() => {
    vi.advanceTimersByTime(65_000);
    return observation;
  });
  const connection = createStreamableHttpJebMcpConnection(
    new URL(fixture.endpoint),
    { requestTimeoutMs: 120_000 },
  );
  await withVerifierCleanup(async () => {
    const signal = AbortSignal.timeout(testWaitDeadline());
    await connection.connect(signal);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    await expect(
      connection.call("decompile_code_item", {}, signal),
    ).resolves.toEqual(observation);
    expect(fixture.calls).toEqual(["decompile_code_item"]);
  }, [() => vi.useRealTimers(), () => connection.close(), fixture.close]);
});

it.each(["tools/call", "tools/list"])(
  "cancels an active %s when the connection owner closes",
  async (method) => {
    const reply = phaseGate();
    let catalogs = 0;
    const catalog = {
      tools: [
        {
          name: "decompile_code_item",
          inputSchema: { type: "object" },
        },
      ],
    };
    const fixture = await startJebMcpFixture(
      async (tool) => {
        if (tool === "decompile_code_item") await reply.hold();
        return { success: true };
      },
      async () => {
        if (++catalogs > 1) await reply.hold();
        return catalog;
      },
    );
    const connection = createStreamableHttpJebMcpConnection(
      new URL(fixture.endpoint),
    );
    await withVerifierCleanup(async () => {
      await connection.connect();
      if (method === "tools/call") {
        const reason = new Error("Cancelled before dispatch");
        const cause = await settledCause(
          connection.call(
            "get_client_information",
            {},
            AbortSignal.abort(reason),
          ),
        );
        expect(cause).toBeInstanceOf(AnalysisCancelledError);
        if (cause instanceof AnalysisCancelledError)
          expect(cause.cause).toBe(reason);
        expect(fixture.calls).toHaveLength(0);
      }

      const pending =
        method === "tools/call"
          ? connection.call("decompile_code_item", {})
          : connection.listTools();
      const rejected = settledCause(pending);
      await reply.reached(pending, method);
      await connection.close();
      const cause = await rejected;
      expect(cause).toBeInstanceOf(AnalysisCancelledError);
      expect(cause).toMatchObject({
        operation:
          method === "tools/call" ? "decompile_code_item" : "jeb_mcp_catalog",
      });
      if (cause instanceof AnalysisCancelledError)
        expect(cause.cause).toBe(OwnerCancellation.ownerClosed);
    }, [() => reply.release(), () => connection.close(), fixture.close]);
  },
);

it.each([false, true])(
  "retains structured own members and nested dictionaries in a JEB reply (isError=%s)",
  (isError) => {
    const structured: unknown = JSON.parse(
      '{"__proto__":{"observed":true},"success":false,"message":"missing","nested":[{"__proto__":"nested fact"}]}',
    );
    const decoded = decodeJebToolResult({
      isError,
      structuredContent: structured,
      content: [],
    });
    expect(Object.hasOwn(decoded as object, "__proto__")).toBe(true);
    expect(JSON.stringify(decoded)).toBe(JSON.stringify(structured));
  },
);

it.each(["1e400", '{"observed":1e400}'])(
  "rejects JEB JSON text outside the JSON value contract: %s",
  (text) => {
    expect(() =>
      decodeJebToolResult({ content: [{ type: "text", text }] }),
    ).toThrow("JSON numbers must be finite");
  },
);

it("accepts omitted JEB content only when structured evidence establishes an observation", () => {
  expect(
    decodeJebToolResult({ structuredContent: { result: "ordinary field" } }),
  ).toEqual({ result: "ordinary field" });
  expect(() => decodeJebToolResult({})).toThrow("empty observation");
  for (const content of [null, {}, [null], [{ type: "text", text: 42 }]])
    expect(() =>
      decodeJebToolResult({ content, structuredContent: { success: true } }),
    ).toThrow();
});

it("selects structured JEB evidence ahead of text while admitting mixed content", () => {
  const image = { type: "image", data: "AA==", mimeType: "image/png" };
  expect(
    decodeJebToolResult({
      content: [image, { type: "text", text: "fallback" }],
      structuredContent: { observed: true },
    }),
  ).toEqual({ observed: true });
  expect(
    decodeJebToolResult({
      content: [image, { type: "text", text: '{"fallback":true}' }],
    }),
  ).toEqual({ fallback: true });
  for (const structuredContent of [null, [], "invalid", { observed: Infinity }])
    expect(() =>
      decodeJebToolResult({
        content: [{ type: "text", text: "fallback" }],
        structuredContent,
      }),
    ).toThrow();
  expect(() => decodeJebToolResult({ content: [image] })).toThrow(
    "empty observation",
  );
  expect(() =>
    decodeJebToolResult({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    }),
  ).toThrow("empty observation");
});
