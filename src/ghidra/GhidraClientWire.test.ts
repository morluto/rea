import type { Socket } from "node:net";

import {
  DEFAULT_BRIDGE_MAX_REPLY,
  type BridgeMaxReplyBytes,
} from "../config/bridgeMaxReplyBytes.js";
import pino from "pino";
import { expect, it, vi } from "vitest";

import type { BridgeMaxRequestBytes } from "../config/bridgeMaxRequestBytes.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok, type Result } from "../domain/result.js";
import { PendingOperations } from "../process/PendingOperations.js";
import { GhidraWire } from "./GhidraClientWire.js";
import {
  bindGhidraSessionFailure,
  type GhidraSessionError,
} from "./GhidraSessionError.js";

const failure = bindGhidraSessionFailure(() => ({
  target_path: "/tmp/wire-fixture",
}));

const limit = (maximumBytes: number): BridgeMaxRequestBytes => ({
  maximumBytes,
  source: "setting",
});

type WireHarness = {
  readonly writes: string[];
  readonly pending: PendingOperations<
    number,
    Result<JsonValue, GhidraSessionError>
  >;
  readonly wire: GhidraWire;
};

const harness = (
  ceiling: BridgeMaxRequestBytes,
  replyCeiling: BridgeMaxReplyBytes = DEFAULT_BRIDGE_MAX_REPLY,
): WireHarness => {
  const writes: string[] = [];
  let nextId = 0;
  const socket = {
    destroyed: false,
    write: (payload: string, callback?: (cause?: Error | null) => void) => {
      writes.push(payload);
      callback?.(null);
      return true;
    },
  } as unknown as Socket;
  const pending = new PendingOperations<
    number,
    Result<JsonValue, GhidraSessionError>
  >();
  return {
    writes,
    pending,
    wire: new GhidraWire({
      getSocket: () => socket,
      getToken: () => "b".repeat(64),
      nextId: () => (nextId += 1),
      pending,
      logger: pino({ level: "silent" }),
      failure,
      bridgeMaxRequestBytes: ceiling,
      bridgeMaxReplyBytes: replyCeiling,
    }),
  };
};

it("reports a lower bound for a request whose size scan stopped early", async () => {
  const method = "search_strings";
  const params = { pattern: "x".repeat(32_768) };
  const maximum = 8_192;
  const { wire, writes, pending } = harness(limit(maximum));
  const result = await wire.request(method, params, {});
  if (result.ok) throw new Error("Expected a request ceiling refusal");
  const cause = result.error.cause;
  if (!(cause instanceof AnalysisResourceConstraintError))
    throw new Error("Expected a transport resource constraint");
  const facts = cause.reportedLimits;
  const measured = facts?.payload_bytes_at_least;
  if (typeof measured !== "number")
    throw new Error("Missing request size lower bound");
  expect(measured).toBeGreaterThan(maximum);
  expect(measured).toBeLessThan(
    Buffer.byteLength(
      JSON.stringify({
        id: 1,
        token: "b".repeat(64),
        method,
        params,
      }),
    ),
  );
  expect(facts).not.toHaveProperty("payload_bytes");
  expect(writes).toEqual([]);
  expect(pending.size).toBe(0);
});

it("admits the exact UTF-8 request boundary without changing reply ownership on refusal", async () => {
  const method = "search_strings";
  const params = { pattern: '前缀"\\\u0000😀\ud800'.repeat(1024) };
  const encoded = JSON.stringify({
    id: 1,
    token: "b".repeat(64),
    method,
    params,
  });
  const size = Buffer.byteLength(encoded, "utf8");
  expect(Buffer.byteLength(params.pattern)).toBeLessThan(size - 1);
  let maximum = 8 * 1024 * 1024;
  const { wire, pending, writes } = harness(limit(size), {
    get maximumBytes() {
      return maximum;
    },
    source: "runtime",
  });
  const admittedReply = {
    maximumBytes: 3 * 1024 * 1024,
    source: "setting",
  } as const;
  expect(wire.replyLimit()).toEqual(DEFAULT_BRIDGE_MAX_REPLY);
  const first = wire.request(method, params, {});
  try {
    maximum = 4 * 1024 * 1024;
    const written = { maximumBytes: 8 * 1024 * 1024, source: "runtime" };
    expect(wire.replyLimit()).toEqual(written);
    expect(writes).toEqual([encoded + "\n"]);
    expect(pending.settle(1, ok("first"))).toBe(true);
    await expect(first).resolves.toEqual(ok("first"));

    const encoding = vi.spyOn(JSON, "stringify");
    try {
      const refused = wire.request(method, params, {
        limits: { requestLimit: limit(size - 1), replyLimit: admittedReply },
      });
      expect(writes).toHaveLength(1);
      expect(pending.size).toBe(0);
      const result = await refused;
      if (result.ok) throw new Error("Expected a request ceiling refusal");
      expect(result.error.kind).toBe("admission");
      expect(result.error.message).toContain("REA_BRIDGE_MAX_REQUEST_BYTES");
      expect(result.error.cause).toBeInstanceOf(
        AnalysisResourceConstraintError,
      );
      expect(result.error.cause).toMatchObject({
        reportedLimits: {
          max_request_bytes: size - 1,
          payload_bytes_at_least: size,
        },
        retryable: false,
      });
      expect(
        encoding.mock.calls.some(
          ([value]: readonly unknown[]) =>
            typeof value === "object" &&
            value !== null &&
            "params" in value &&
            value.params === params,
        ),
      ).toBe(false);
    } finally {
      encoding.mockRestore();
    }
    expect(wire.replyLimit()).toEqual(written);

    const second = wire.request(
      "ping",
      {},
      {
        limits: { requestLimit: limit(size), replyLimit: admittedReply },
      },
    );
    expect(writes).toHaveLength(2);
    expect(wire.replyLimit()).toEqual(admittedReply);
    expect(pending.settle(3, ok("second"))).toBe(true);
    await expect(second).resolves.toEqual(ok("second"));
    expect(pending.size).toBe(0);
  } finally {
    pending.failAll(() => ok(null));
    await first;
  }
});

it("refuses an invalid request seed without sending or leaving a pending reply", async () => {
  const refusal = new ConfigurationError("Invalid request seed", {
    settings: [
      {
        setting: "REA_BRIDGE_MAX_REQUEST_BYTES",
        constraint: "a positive decimal integer",
      },
    ],
  });
  const { writes, pending, wire } = harness({
    get maximumBytes(): number {
      throw refusal;
    },
    source: "setting",
  });

  const request = wire.request("ping", {}, {});
  try {
    expect(writes).toEqual([]);
    expect(pending.size).toBe(0);
    const result = await request;
    if (result.ok) throw new Error("Expected a configuration refusal");
    expect(result.error.kind).toBe("admission");
    expect(result.error.configurationFailure).toBe(refusal);
    expect(result.error.cause).toBe(refusal);
  } finally {
    pending.failAll(() => ok(null));
    await request;
  }
});

it("preserves distinct decompile and value-flow options on the wire", async () => {
  const { wire, writes, pending } = harness(limit(8192));
  const valueFlowLimits = {
    max_operations: 6000,
    max_inputs_per_operation: 128,
    max_edges: 24000,
  };
  const params = { procedure: "0x1000" };
  const method = "procedure_pseudo_code";
  const first = wire.request(method, params, {
    decompileTimeoutSeconds: 7,
    decompileMaxPayloadMiB: null,
    valueFlowLimits,
  });
  try {
    expect(JSON.parse(writes[0]!)).toEqual({
      id: 1,
      token: "b".repeat(64),
      method,
      params,
      decompile_timeout_seconds: 7,
      decompile_max_payload_mib: null,
      value_flow_limits: {
        max_operations: 6000,
        max_inputs_per_operation: 128,
        max_edges: 24000,
      },
    });
    expect(pending.settle(1, ok("first"))).toBe(true);
    await expect(first).resolves.toEqual(ok("first"));

    const second = wire.request(method, params, {
      decompileTimeoutSeconds: null,
      decompileMaxPayloadMiB: 31,
      decompileReadAhead: ["0x1000", "0x2000"],
    });
    expect(JSON.parse(writes[1]!)).toEqual({
      id: 2,
      token: "b".repeat(64),
      method,
      params,
      decompile_timeout_seconds: null,
      decompile_max_payload_mib: 31,
      decompile_read_ahead: ["0x1000", "0x2000"],
    });
    expect(pending.settle(2, ok("second"))).toBe(true);
    await expect(second).resolves.toEqual(ok("second"));
  } finally {
    pending.failAll(() => ok(null));
    await first;
  }
});

it("writes one authenticated cancel frame for an interrupted request and keeps awaiting its reply", async () => {
  const { wire, writes, pending } = harness(limit(8_192));
  const interrupt = new AbortController();
  const request = wire.request(
    "procedure_pseudo_code",
    { procedure: "main" },
    { interrupt: interrupt.signal },
  );
  expect(writes).toHaveLength(1);
  interrupt.abort("caller stopped");
  // The cancel is a request frame with its own id; the request stays pending.
  expect(writes.slice(1).map((line) => JSON.parse(line) as JsonValue)).toEqual([
    {
      id: 2,
      token: "b".repeat(64),
      method: "cancel",
      params: { request_id: 1 },
    },
  ]);
  expect(writes[1]?.endsWith("\n")).toBe(true);
  expect(pending.has(1)).toBe(true);
  expect(pending.has(2)).toBe(false);
  pending.settle(1, ok({ answered: true }));
  await expect(request).resolves.toEqual(ok({ answered: true }));
});

it("takes read-ahead ownership only after the request passes admission", async () => {
  const maximum = 8_192;
  const { wire, writes, pending } = harness(limit(maximum));
  let admitted = 0;
  const refused = await wire.request(
    "procedure_pseudo_code",
    { procedure: "x".repeat(32_768) },
    {
      decompileReadAhead: ["0x1000", "0x1010"],
      onAdmitted: () => {
        admitted += 1;
      },
    },
  );
  expect(refused.ok).toBe(false);
  if (refused.ok) return;
  expect(refused.error.kind).toBe("admission");
  expect(admitted).toBe(0);
  expect(writes).toEqual([]);

  const accepted = wire.request(
    "procedure_pseudo_code",
    { procedure: "0x1000" },
    {
      decompileReadAhead: ["0x1000", "0x1010"],
      onAdmitted: () => {
        admitted += writes.length === 0 ? 1 : 10;
      },
    },
  );
  expect(pending.settle(2, ok(null))).toBe(true);
  await accepted;
  expect(admitted).toBe(1);
  expect(writes).toHaveLength(1);
});

it("writes an abandon frame without registering a reply", () => {
  const { wire, writes, pending } = harness(limit(8_192));
  wire.abandonReadAhead();
  expect(writes.map((line) => JSON.parse(line) as JsonValue)).toEqual([
    {
      id: 1,
      token: "b".repeat(64),
      method: "abandon_decompile_read_ahead",
      params: {},
    },
  ]);
  expect(writes[0]?.endsWith("\n")).toBe(true);
  expect(pending.size).toBe(0);
});

it("writes no cancel frame once the interrupted request has settled", async () => {
  const { wire, writes, pending } = harness(limit(8_192));
  const interrupt = new AbortController();
  const request = wire.request(
    "procedure_pseudo_code",
    {},
    {
      interrupt: interrupt.signal,
    },
  );
  pending.settle(1, ok(null));
  // Before the request's own continuation runs, and after it.
  interrupt.abort("caller stopped");
  await request;
  expect(writes).toHaveLength(1);
});
