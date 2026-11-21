import { z } from "zod";
import { describe, expect, it, vi } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import { DEFAULT_BRIDGE_MAX_REQUEST_BYTES } from "../domain/analysisResourceLimits.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok } from "../domain/result.js";
import { silentLogger } from "../logger.js";
import { HopperClient } from "./HopperClient.js";
import { HopperProvider } from "./HopperProvider.js";
import { HOPPER_OPERATIONS } from "./HopperProviderMetadata.js";
import {
  hopperBridgeMethod,
  parseHopperReply as parseHopperReplyWith,
  HopperReplyContractError,
  hopperReplySchemas,
  type HopperReplyMethod,
  parseHopperServerInfo,
  parseHopperShutdownReply,
} from "./HopperReplyContracts.js";

/**
 * Stand in for the client's own reply check: `HopperClient.callTool` validates
 * each reply against its method contract before the provider reads it.
 */
const validatedReply =
  (reply: JsonValue) =>
  (
    method: HopperReplyMethod,
    _arguments?: unknown,
    options?: { readonly operation?: string },
  ) =>
    Promise.resolve(
      parseHopperReplyWith(
        hopperReplySchemas,
        method,
        reply,
        options?.operation ?? method,
      ),
    );

const parseHopperReply = <M extends HopperReplyMethod>(
  method: M,
  value: JsonValue,
  operation: string = method,
) => parseHopperReplyWith(hopperReplySchemas, method, value, operation);

it("gives every Hopper operation's bridge method a reply contract", () => {
  const missing = HOPPER_OPERATIONS.map(hopperBridgeMethod).filter(
    (method) => !Object.hasOwn(hopperReplySchemas, method),
  );

  expect(missing, "no Hopper reply reaches Evidence unvalidated").toEqual([]);
});

it.each([
  [
    "closed",
    { shutdown: true, analysis_stopped: true, document_closed: true },
    "confirmed",
  ],
  [
    "retained",
    {
      shutdown: true,
      analysis_stopped: false,
      document_closed: false,
      document_retained: true,
    },
    "confirmed",
  ],
  [
    "cleanup required",
    {
      shutdown: true,
      analysis_stopped: true,
      document_closed: false,
      cleanup_required: true,
    },
    "cleanup_required",
  ],
  [
    "analysis still running",
    { shutdown: true, analysis_stopped: false, document_closed: true },
    "unconfirmed",
  ],
  [
    "document still open",
    { shutdown: true, analysis_stopped: true, document_closed: false },
    "unconfirmed",
  ],
] as const)("reads a %s shutdown reply", (_case, reply, outcome) => {
  for (const method of ["shutdown", "shutdown_document"] as const)
    expect(parseHopperShutdownReply(method, reply)).toEqual(ok(outcome));
});

it.each([
  ["missing analysis state", { shutdown: true, document_closed: true }],
  [
    "string flag",
    { shutdown: "true", analysis_stopped: true, document_closed: true },
  ],
  ["non-object", true],
] as const)(
  "refuses a %s shutdown reply with field diagnostics",
  (_case, reply) => {
    expect(parseHopperShutdownReply("shutdown", reply)).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        diagnostics: { contract_issue_count: expect.any(Number) },
      },
    });
  },
);

it("returns the validated source reply without dropping unlisted fields", () => {
  const reply = [
    {
      address: "0x10",
      value: "text",
      provider_value: "text",
      provider_metadata: { section: "__cstring" },
    },
  ];

  const parsed = parseHopperReply("list_strings", reply);

  expect(parsed).toEqual({ ok: true, value: reply });
  expect(parsed.ok && parsed.value).toBe(reply);
});

it("names the requesting operation and the bridge method in a contract failure", () => {
  const parsed = parseHopperReply(
    "list_procedures",
    [{ address: "0x10" }],
    "search_procedures",
  );

  expect(parsed.ok ? undefined : parsed.error).toMatchObject({
    _tag: "AnalysisOutputError",
    operation: "search_procedures",
    method: "list_procedures",
    message: expect.stringContaining("list_procedures contract"),
  });
});

it("keeps the raw reply on a contract failure as partial evidence", () => {
  const reply = [{ address: "0x10" }];
  const parsed = parseHopperReply("list_procedures", reply);

  if (parsed.ok) throw new Error("Expected a contract failure");
  expect(parsed.error).toBeInstanceOf(HopperReplyContractError);
  expect(parsed.error.reply).toBe(reply);
});

it("names each failing field without echoing reported text", () => {
  const region = {
    name: "secret-name",
    start: "0x0",
    end: "0x10",
    readable: null,
    writable: null,
    executable: null,
    permissions: { available: false, reason: "unavailable" },
    provenance: "hopper-public-python-api",
  };

  const parsed = parseHopperReply("list_segments", [
    { ...region, sections: [{ ...region, name: null }] },
  ]);

  const error = parsed.ok ? undefined : parsed.error;
  expect(error?.diagnostics).toEqual({
    contract_issue_count: 1,
    contract_issues: [
      {
        path: [0, "sections", 0, "name"],
        code: "invalid_type",
        expected: "string",
        received: "null",
      },
    ],
  });
  expect(JSON.stringify(error?.diagnostics)).not.toContain("secret-name");
});

it("names the nested field of each option a failed union tried", () => {
  const parsed = parseHopperReply("list_segments", [
    {
      name: "segment",
      start: "0x0",
      end: "0x10",
      readable: null,
      writable: null,
      executable: null,
      permissions: { available: false, reason: null },
      provenance: "hopper-public-python-api",
      sections: [],
    },
  ]);

  const diagnostics = parsed.ok ? undefined : parsed.error.diagnostics;
  expect(diagnostics?.["contract_issues"]).toContainEqual({
    path: [0, "permissions", "reason"],
    code: "invalid_type",
    union_branches: [0],
    expected: "string",
    received: "null",
  });
});

const providerClient = () => {
  const config = parseConfig({});
  if (!config.ok) throw config.error;
  return new HopperProvider(
    config.value,
    silentLogger,
    {},
    "linux",
  ).createClient({
    path: "/tmp/fixture.hop",
    sha256: "a".repeat(64),
    kind: "database",
    format: "analysis-database",
    databaseEngine: "hopper",
  });
};
const nameRow = { address: "0x10", value: "main", provider_metadata: { n: 1 } };
const stringRow = {
  address: "0x20",
  value: "text",
  provider_value: "text",
  provider_metadata: { n: 2 },
};

const entryCases: readonly (readonly [
  (
    | "list_procedures"
    | "list_strings"
    | "search_procedures"
    | "search_strings"
    | "list_documents"
  ),
  Readonly<Record<string, JsonValue>>,
  JsonValue,
  JsonValue,
])[] = [
  ["list_procedures", {}, [nameRow], [{ address: "0x10" }]],
  ["list_strings", {}, [stringRow], [{ value: "text" }]],
  ["search_procedures", { pattern: "m" }, [nameRow], { rows: [] }],
  ["search_strings", { pattern: "t" }, [stringRow], [{ address: 1 }]],
  ["list_documents", {}, ["fixture.hop"], [42]],
];

describe("provider entry paths apply the reply contract", () => {
  it.each(entryCases)(
    "%s keeps a valid reply and rejects a malformed one",
    async (operation, parameters, valid, malformed) => {
      const callTool = vi.spyOn(HopperClient.prototype, "callTool");
      const client = providerClient();
      try {
        callTool.mockResolvedValueOnce(ok(structuredClone(valid)));
        const accepted = await client.execute(operation, parameters);
        expect(
          accepted.ok ? accepted.value.result : accepted.error,
          "unlisted source fields survive",
        ).toEqual(valid);

        callTool.mockImplementationOnce(
          validatedReply(structuredClone(malformed)) as never,
        );
        const rejected = await client.execute(operation, parameters);
        expect(rejected.ok ? undefined : rejected.error).toMatchObject({
          _tag: "AnalysisOutputError",
          message: expect.stringContaining(`${operation} contract`),
        });
      } finally {
        try {
          await client.close();
        } finally {
          callTool.mockRestore();
        }
      }
    },
  );

  it.each(["list_procedures", "list_documents"] as const)(
    "%s rejects a malformed reply on the ready path",
    async (operation) => {
      const ready = vi
        .spyOn(HopperClient.prototype, "callToolIfReady")
        .mockImplementation(validatedReply([{ unexpected: true }]) as never);
      const client = providerClient();
      try {
        const result = await client.executeIfReady?.(operation, {});
        expect(result?.ok ? undefined : result?.error).toMatchObject({
          _tag: "AnalysisOutputError",
          message: expect.stringContaining(`${operation} contract`),
        });
      } finally {
        try {
          await client.close();
        } finally {
          ready.mockRestore();
        }
      }
    },
  );
});

it("refuses, at compile time, a contract that would change the reply", () => {
  const coercing = { count: z.object({ count: z.coerce.number() }) };
  const defaulted = { label: z.object({ label: z.string().default("x") }) };
  // @ts-expect-error A coercion promises a number the raw reply does not hold.
  const coerced = parseHopperReplyWith(coercing, "count", { count: "1" }, "op");
  // @ts-expect-error A default promises a field the raw reply may lack.
  const filled = parseHopperReplyWith(defaulted, "label", {}, "op");

  // The raw reply is returned, which is why such contracts are refused.
  expect(coerced).toEqual({ ok: true, value: { count: "1" } });
  expect(filled).toEqual({ ok: true, value: {} });
});

describe("Hopper health reply", () => {
  const health = {
    name: "REA Hopper bridge",
    version: "1.0.0",
    process_id: 42,
    run_id: "run-1",
  };

  it("treats an omitted request ceiling as the 16 MiB default", () => {
    expect(parseHopperServerInfo(health, "run-1")).toEqual({
      ok: true,
      value: {
        name: "REA Hopper bridge",
        version: "1.0.0",
        processId: 42,
        maxRequestBytes: DEFAULT_BRIDGE_MAX_REQUEST_BYTES,
      },
    });
  });

  it("keeps an advertised ceiling that differs from the client default", () => {
    const parsed = parseHopperServerInfo(
      { ...health, max_request_bytes: 8192 },
      "run-1",
    );
    expect(parsed.ok && parsed.value.maxRequestBytes).toBe(8192);
  });

  it.each<[string, JsonValue]>([
    ["zero ceiling", { ...health, max_request_bytes: 0 }],
    ["negative ceiling", { ...health, max_request_bytes: -1 }],
    ["fractional ceiling", { ...health, max_request_bytes: 1.5 }],
    ["text ceiling", { ...health, max_request_bytes: "16777216" }],
    ["boolean ceiling", { ...health, max_request_bytes: true }],
    ["null ceiling", { ...health, max_request_bytes: null }],
    ["another peer", { ...health, name: "Other bridge" }],
    ["another run", { ...health, run_id: "run-2" }],
    ["no version", { name: health.name, process_id: 42, run_id: "run-1" }],
    ["zero process", { ...health, process_id: 0 }],
    ["unsafe process", { ...health, process_id: 2 ** 53 }],
    ["array", [health]],
  ])("refuses a health reply with %s", (_case, value) => {
    const parsed = parseHopperServerInfo(value, "run-1");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error._tag).toBe("HopperProtocolError");
      expect(parsed.error.message).toBe(
        "Hopper bridge health result is invalid",
      );
    }
  });
});
