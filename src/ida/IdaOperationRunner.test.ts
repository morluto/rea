import { rm } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  createIdaTarget,
  RecordingIdaMcp,
} from "../../tests/fixtures/idaMcp.js";
import { IdaOperationRunner } from "./IdaOperationRunner.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";

/** The fixture serves the native protocol attached and the supervisor headless. */
const producerFor = (target: BinaryTarget, protocol: "modern" | "native") =>
  new RecordingIdaMcp(target, protocol === "native" ? "attached" : "headless");

it.each(["modern", "native"] as const)(
  "%s validates string address selectors independently of inventory contents",
  async (protocol) => {
    const { root, target } = await createIdaTarget();
    const producer = producerFor(target, protocol);
    const runner = new IdaOperationRunner(producer, protocol);
    try {
      for (const populated of [false, true]) {
        const strings = populated
          ? [
              { address: "0x10", string: "selected", length: 8 },
              { address: "0x20", string: "other", length: 5 },
            ]
          : [];
        producer.overrideCall = (tool) => {
          if (tool === "find_regex")
            return {
              matches: strings.map(({ address, string }) => ({
                addr: address,
                string,
              })),
              cursor: { done: true },
            };
          return undefined;
        };
        const callsBeforeInvalidSelector = producer.calls.length;
        await expect(
          runner.run("list_strings", { address: "invalid" }),
        ).rejects.toThrow();
        expect(producer.calls).toHaveLength(callsBeforeInvalidSelector);
        expect(await runner.run("list_strings", { address: "0X0010" })).toEqual(
          populated ? [{ address: "0x10", value: "selected" }] : [],
        );
      }
    } finally {
      await producer.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["modern", "native"] as const)(
  "%s procedure resolution rejects file coordinates before any symbol lookup",
  async (protocol) => {
    const { root, target } = await createIdaTarget();
    const producer = producerFor(target, protocol);
    const runner = new IdaOperationRunner(producer, protocol);
    try {
      await expect(
        runner.resolve("file-offset:0x10", "procedure_pseudo_code"),
      ).rejects.toMatchObject({
        _tag: "AnalysisInputError",
        operation: "procedure_pseudo_code",
        issues: [
          {
            path: ["procedure"],
            message: expect.stringContaining("source-file coordinates"),
          },
        ],
      });
      expect(producer.calls).toEqual([]);
      expect((await runner.resolve("main")).name).toBe("main");
    } finally {
      await producer.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each(["modern", "native"] as const)(
  "%s retains function identities independently of unused source spans",
  async (protocol) => {
    const { root, target } = await createIdaTarget();
    const producer = producerFor(target, protocol);
    const runner = new IdaOperationRunner(producer, protocol);
    try {
      // Cover omitted, malformed and normal source spans at the connection seam.
      const spans: Record<string, JsonValue>[] = [
        {},
        { size: null },
        { size: { bytes: 32 } },
        { size: "0x20" },
      ];
      for (const span of spans) {
        const modernFn = { addr: "0x1000", name: "main", ...span };
        producer.overrideCall = (tool) => {
          switch (tool) {
            case "list_funcs":
              return [{ data: [modernFn], next_offset: null }];
            case "lookup_funcs":
              return [{ query: "main", fn: modernFn, error: null }];
            case "xrefs_to":
              return [
                {
                  xrefs: [{ addr: "0x1004", type: "code", fn: modernFn }],
                  more: false,
                },
              ];
            default:
              return undefined;
          }
        };
        expect(await runner.run("list_procedures", {})).toEqual([
          { address: "0x1000", value: "main" },
        ]);
        expect(await runner.resolve("main")).toEqual({
          address: "0x1000",
          name: "main",
        });
        expect(await runner.xrefs("0x1000")).toEqual([
          {
            address: "0x1004",
            type: "code",
            function: { address: "0x1000", name: "main" },
          },
        ]);
        const instructions = await runner.run("read_function_instructions", {
          procedure: "main",
        });
        expect(instructions).toMatchObject({
          procedure: {
            address: "0x1000",
            name: "main",
            body: {
              available: false,
              reason: expect.stringContaining("complete function body ranges"),
            },
          },
        });
        expect(runner.raw).toContainEqual(
          expect.objectContaining({
            tool: "list_funcs",
            result: [{ data: [modernFn], next_offset: null }],
          }),
        );
      }
      for (const malformed of [
        { address: "invalid", name: "main" },
        { address: "0x1000", name: "" },
      ]) {
        producer.overrideCall = (tool): JsonValue | undefined => {
          if (tool === "lookup_funcs")
            return [{ query: "main", fn: malformed, error: null }];
          return undefined;
        };
        await expect(runner.resolve("main")).rejects.toThrow();
      }
    } finally {
      await producer.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  ["modern", "functions"],
  ["native", "functions"],
  ["modern", "strings"],
  ["native", "strings"],
] as const)(
  "%s %s inventory rejects a repeated or backward offset before another request",
  async (protocol, inventory) => {
    const { root, target } = await createIdaTarget();
    const producer = producerFor(target, protocol);
    try {
      for (const next of [2, 1]) {
        let pages = 0;
        producer.overrideCall = (tool) => {
          if (!["list_funcs", "find_regex"].includes(tool)) return undefined;
          const nextOffset = pages++ === 0 ? 2 : next;
          if (tool === "find_regex")
            return { matches: [], cursor: { next: nextOffset } };
          return [{ data: [], next_offset: nextOffset }];
        };
        const runner = new IdaOperationRunner(producer, protocol);
        await expect(runner[inventory]()).rejects.toMatchObject({
          _tag: "AnalysisProtocolError",
        });
        expect(pages).toBe(2);
      }
    } finally {
      await producer.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
