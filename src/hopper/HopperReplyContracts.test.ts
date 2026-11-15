import { describe, expect, it, vi } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok } from "../domain/result.js";
import { silentLogger } from "../logger.js";
import { HopperClient } from "./HopperClient.js";
import { HopperProvider } from "./HopperProvider.js";
import { HOPPER_OPERATIONS } from "./HopperProviderMetadata.js";
import {
  hasHopperReplyContract,
  hopperBridgeMethod,
  parseHopperReply,
} from "./HopperReplyContracts.js";

it("gives every Hopper operation's bridge method a reply contract", () => {
  const missing = HOPPER_OPERATIONS.map(hopperBridgeMethod).filter(
    (method) => !hasHopperReplyContract(method),
  );

  expect(missing, "no Hopper reply reaches Evidence unvalidated").toEqual([]);
});

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
    message: expect.stringContaining("list_procedures contract"),
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

        callTool.mockResolvedValueOnce(ok(structuredClone(malformed)));
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
        .mockResolvedValue(ok([{ unexpected: true }]));
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
