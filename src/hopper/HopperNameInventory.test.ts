import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../config/parseConfig.js";
import { ok } from "../domain/result.js";
import { silentLogger } from "../logger.js";
import { HopperClient } from "./HopperClient.js";
import { HopperProvider } from "./HopperProvider.js";

import { projectHopperNameInventory } from "./HopperNameInventory.js";
import {
  hopperReplySchemas,
  parseHopperReply as parseHopperReplyWith,
  type HopperReplyMethod,
} from "./HopperReplyContracts.js";
import type { JsonValue } from "../domain/jsonValue.js";

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

describe("Hopper name inventory labels", () => {
  it("tags stripped class-object labels without rewriting source values", () => {
    const value = [
      {
        address: "0x1",
        value: "__objc_class_HuntRoot_class",
        provider_metadata: { section: "__DATA,__objc_classrefs" },
      },
      {
        address: "0x2",
        value: "__objc_class_Hunt_class_class",
        provider_metadata: { section: "__DATA,__objc_classrefs" },
      },
      { address: "0x3", value: "_OBJC_CLASS_$_Unchanged" },
      { address: "0x4", value: "prefix__objc_class_Foreign_class" },
      { address: "0x5", value: "__objc_class__class" },
      { address: "0x6", value: "__objc_class_MissingSuffix" },
      { address: "0x7", value: "__objc_class_Extra_class_suffix" },
    ];

    expect(projectHopperNameInventory(value)).toEqual({
      changed: true,
      result: [
        {
          address: "0x1",
          value: "__objc_class_HuntRoot_class",
          provider_metadata: { section: "__DATA,__objc_classrefs" },
          objc_class_label: "hopper_legacy_class_object",
        },
        {
          address: "0x2",
          value: "__objc_class_Hunt_class_class",
          provider_metadata: { section: "__DATA,__objc_classrefs" },
          objc_class_label: "hopper_legacy_class_object",
        },
        value[2],
        value[3],
        value[4],
        value[5],
        value[6],
      ],
    });
  });

  it("replaces a provider-supplied label tag with the Hopper-owned classification", () => {
    const value = [
      {
        address: "0x2",
        value: "ordinary_name",
        objc_class_label: "hopper_legacy_class_object" as const,
        provider_metadata: { ordinal: 4 },
      },
    ];

    expect(projectHopperNameInventory(value)).toEqual({
      changed: true,
      result: [
        {
          address: "0x2",
          value: "ordinary_name",
          provider_metadata: { ordinal: 4 },
        },
      ],
    });
  });

  it("preserves source rows and the exact raw reply through the provider boundary", async () => {
    const config = parseConfig({});
    if (!config.ok) throw config.error;
    const source = [
      {
        address: "0x1",
        value: "__objc_class_HuntRoot_class",
        provider_metadata: { section: "__DATA,__objc_classrefs" },
      },
      {
        address: "0x2",
        value: "ordinary_name",
        provider_metadata: { ordinal: 2 },
        objc_class_label: "hopper_legacy_class_object",
      },
    ];
    const originalSource = structuredClone(source);
    const callTool = vi
      .spyOn(HopperClient.prototype, "callTool")
      .mockResolvedValue(ok(source));
    const provider = new HopperProvider(
      config.value,
      silentLogger,
      {},
      "linux",
    );
    const client = provider.createClient({
      path: "/tmp/fixture.hop",
      sha256: "a".repeat(64),
      kind: "database",
      format: "analysis-database",
      databaseEngine: "hopper",
    });

    try {
      const result = await client.execute("list_names", {});
      expect(callTool).toHaveBeenCalledOnce();
      if (!result.ok) throw result.error;
      expect(result.value.result).toEqual([
        {
          ...originalSource[0],
          objc_class_label: "hopper_legacy_class_object",
        },
        {
          address: "0x2",
          value: "ordinary_name",
          provider_metadata: { ordinal: 2 },
        },
      ]);
      expect(result.value.rawResult).toEqual(originalSource);
      expect(source).toEqual(originalSource);
    } finally {
      try {
        await client.close();
      } finally {
        callTool.mockRestore();
      }
    }
  });
});

describe("Hopper list_names reply contract", () => {
  it.each([
    ["a non-inventory object", { unexpected: "shape" }],
    ["rows missing their value", [{ address: "0x1" }]],
    [
      "a label outside the name contract",
      [{ address: "0x1", value: "name", objc_class_label: "other" }],
    ],
  ])(
    "rejects a list_names reply with %s instead of passing it through",
    async (_label, reply) => {
      const config = parseConfig({});
      if (!config.ok) throw config.error;
      const callTool = vi
        .spyOn(HopperClient.prototype, "callTool")
        .mockImplementation(validatedReply(reply) as never);
      const client = new HopperProvider(
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

      try {
        const result = await client.execute("list_names", {});
        expect(
          result.ok ? undefined : result.error,
          "a reply outside the bridge contract never becomes Evidence",
        ).toMatchObject({
          _tag: "AnalysisOutputError",
          message: expect.stringContaining("list_names contract"),
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
});
