import { expect, it } from "vitest";
import { RecordingIdaMcp } from "../../tests/fixtures/idaMcp.js";
import { IdaOperationRunner } from "./IdaOperationRunner.js";
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

it("projects the native xref source function and retains unused span evidence", async () => {
  const producer = new RecordingIdaMcp(target, "attached");
  const runner = new IdaOperationRunner(producer, "native");
  const response = [
    {
      xrefs: [
        {
          addr: "0x1004",
          type: "code",
          fn: { addr: "0x1000", name: "main", size: { bytes: 32 } },
        },
      ],
      more: false,
      error: null,
    },
  ];
  producer.overrideCall = (tool) =>
    tool === "xrefs_to" ? response : undefined;
  expect(await runner.xrefs("0x1000")).toEqual([
    {
      address: "0x1004",
      type: "code",
      function: { address: "0x1000", name: "main" },
    },
  ]);
  expect(runner.raw).toEqual([
    {
      tool: "xrefs_to",
      arguments: { addrs: ["0x1000"], limit: 1000 },
      result: response,
    },
  ]);
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

it("emits actionable procedure lookup remediation on missing function", async () => {
  const producer = new RecordingIdaMcp(target, "headless");
  producer.overrideCall = (tool) =>
    tool === "lookup_funcs"
      ? [{ query: "missing_fn", fn: null, error: "Not found" }]
      : undefined;
  const runner = new IdaOperationRunner(producer, "modern");
  let caughtError: unknown;
  try {
    await runner.resolve("missing_fn", "procedure_pseudo_code");
  } catch (err) {
    caughtError = err;
  }
  expect(caughtError).toMatchObject({
    _tag: "AnalysisInputError",
    operation: "procedure_pseudo_code",
    conformsToInputContract: true,
    remediationAction: expect.stringContaining("search_procedures"),
  });
  expect((caughtError as any).remediationAction).toContain(
    'CLI: rea search <path> "missing_fn" --kind procedures --provider ida',
  );
  expect((caughtError as any).remediationAction).toContain(
    'MCP: use search_procedures with {"pattern":"missing_fn"} or list_procedures',
  );
});

it("emits address-aware procedure lookup remediation for missing address selectors", async () => {
  const producer = new RecordingIdaMcp(target, "headless");
  producer.overrideCall = (tool) =>
    tool === "lookup_funcs"
      ? [{ query: "0x1000", fn: null, error: "Not a function" }]
      : undefined;
  const runner = new IdaOperationRunner(producer, "modern");
  let caughtError: unknown;
  try {
    await runner.resolve("0x1000", "procedure_pseudo_code");
  } catch (err) {
    caughtError = err;
  }
  expect(caughtError).toMatchObject({
    _tag: "AnalysisInputError",
    operation: "procedure_pseudo_code",
    conformsToInputContract: true,
  });
  expect((caughtError as any).remediationAction).toContain(
    "IDA couldn't resolve address 0x1000 to a function in this project",
  );
  expect((caughtError as any).remediationAction).toContain(
    "CLI: rea search <path> . --kind procedures --mode regex --provider ida",
  );
});
