import { expect, it } from "vitest";
import { RecordingIdaMcp } from "../../tests/fixtures/idaMcp.js";
import { IdaOperationRunner } from "./IdaOperationRunner.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";

const target: BinaryTarget = {
  path: "/fixture/target.elf",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
};

it("rejects invalid string addresses before reading and resolves canonical selectors", async () => {
  const producer = new RecordingIdaMcp(target, "attached");
  const runner = new IdaOperationRunner(producer, "native");
  producer.overrideCall = (tool) =>
    tool === "find_regex"
      ? {
          matches: [
            { addr: "0x10", string: "selected" },
            { addr: "0x20", string: "other" },
          ],
          cursor: { done: true },
        }
      : undefined;

  await expect(
    runner.run("list_strings", { address: "invalid" }),
  ).rejects.toThrow();
  expect(producer.calls).toEqual([]);
  expect(await runner.run("list_strings", { address: "0X0010" })).toEqual([
    { address: "0x10", value: "selected" },
  ]);
  expect(await runner.run("list_strings", { address: "0x30" })).toEqual([]);
});

it("rejects file coordinates before any symbol lookup", async () => {
  const producer = new RecordingIdaMcp(target, "headless");
  const runner = new IdaOperationRunner(producer, "modern");

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
  expect(await runner.resolve("main")).toEqual({
    address: "0x1000",
    name: "main",
  });
});

it("retains usable function identities and raw spans without inventing body ranges", async () => {
  const producer = new RecordingIdaMcp(target, "attached");
  const runner = new IdaOperationRunner(producer, "native");
  const identity = { address: "0x1000", name: "main" };
  const spans: Record<string, JsonValue>[] = [
    {},
    { size: null },
    { size: { bytes: 32 } },
    { size: "0x20" },
  ];
  for (const span of spans) {
    const fn = { addr: "0x1000", name: "main", ...span };
    const inventory = [{ data: [fn], next_offset: null }];
    producer.overrideCall = (tool) => {
      switch (tool) {
        case "list_funcs":
          return inventory;
        case "lookup_funcs":
          return [{ query: "main", fn, error: null }];
        case "xrefs_to":
          return [
            {
              xrefs: [{ addr: "0x1004", type: "code", fn }],
              more: false,
              error: null,
            },
          ];
        default:
          return undefined;
      }
    };

    expect(await runner.run("list_procedures", {})).toEqual([
      { address: "0x1000", value: "main" },
    ]);
    expect(await runner.resolve("main")).toEqual(identity);
    expect(await runner.xrefs("0x1000")).toEqual([
      { address: "0x1004", type: "code", function: identity },
    ]);
    expect(
      await runner.run("read_function_instructions", { procedure: "main" }),
    ).toMatchObject({
      procedure: {
        ...identity,
        body: {
          available: false,
          reason: expect.stringContaining("complete function body ranges"),
        },
      },
    });
    expect(runner.raw).toContainEqual(
      expect.objectContaining({ tool: "list_funcs", result: inventory }),
    );
  }

  for (const fn of [
    { address: "invalid", name: "main" },
    { address: "0x1000", name: "" },
  ]) {
    producer.overrideCall = (tool) =>
      tool === "lookup_funcs"
        ? [{ query: "main", fn, error: null }]
        : undefined;
    await expect(runner.resolve("main")).rejects.toThrow();
  }
});

it.each([
  ["functions", "list_funcs", "modern"],
  ["strings", "find_regex", "native"],
] as const)(
  "%s inventory rejects repeated and backward offsets before a third request",
  async (inventory, tool, protocol) => {
    for (const next of [2, 1]) {
      const producer = new RecordingIdaMcp(
        target,
        protocol === "native" ? "attached" : "headless",
      );
      producer.overrideCall = (name) => {
        if (name !== tool || producer.calls.length > 2)
          throw new Error("Unexpected inventory request");
        const nextOffset = producer.calls.length === 1 ? 2 : next;
        return tool === "find_regex"
          ? { matches: [], cursor: { next: nextOffset } }
          : [{ data: [], next_offset: nextOffset }];
      };
      const runner = new IdaOperationRunner(producer, protocol);
      await expect(runner[inventory]()).rejects.toMatchObject({
        _tag: "AnalysisProtocolError",
      });
      expect(producer.calls).toEqual(
        [0, 2].map((offset) => ({
          name: tool,
          args:
            tool === "find_regex"
              ? { pattern: "[\\s\\S]*", offset, limit: 100 }
              : { queries: { offset, count: 100 } },
        })),
      );
    }
  },
);
