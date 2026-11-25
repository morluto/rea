import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { UNCLASSIFIED_CALL_SITE_LIMITATION } from "../../../../src/ida/IdaCallGraph.js";
import { IdaOperationRunner } from "../../../../src/ida/IdaOperationRunner.js";
import { IdaSessionClient } from "../../../../src/ida/IdaSessionClient.js";
import { createIdaTarget, RecordingIdaMcp } from "../../../fixtures/idaMcp.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const queriesSchema = z.object({ queries: z.array(z.string()) });
/** An uncapped inventory still cannot establish every possible callee. */
const uncappedCalleeCoverage = {
  status: "complete",
  discovery: {
    callees: { status: "unknown", reason: UNCLASSIFIED_CALL_SITE_LIMITATION },
  },
};
const addresses = Array.from(
  { length: 20 },
  (_, index) => `0x${(0x2000 + index * 16).toString(16)}`,
);
const row = (query: string) => ({
  query,
  fn: {
    address: query === "main" ? "0x1000" : query,
    name: query === "main" ? "main" : `sub_${query}`,
    size: "0x10",
  },
  error: null,
});
const fixture = async (mode: "attached" | "headless" = "headless") => {
  const { root, target } = await createIdaTarget();
  roots.push(root);
  const producer = new RecordingIdaMcp(target, mode);
  producer.overrideCall = (name, args) => {
    if (name === "lookup_funcs")
      return queriesSchema.parse(args).queries.map(row).reverse();
    if (name === "callees")
      return [
        {
          callees: [
            ...addresses.map((addr) => ({
              addr,
              name: `callee_${addr}`,
              type: "internal",
            })),
            { addr: addresses[0]!, name: "duplicate", type: "internal" },
            { addr: "0x9000", name: "external", type: "external" },
          ],
          more: false,
          ...(mode === "attached" ? { error: null } : {}),
        },
      ];
    return undefined;
  };
  return { root, target, producer };
};

it.each([
  "missing",
  "duplicate",
  "unrequested",
  "Not found",
  "Not a function",
  "database unavailable",
])("preserves a producer fault for %s batch rows", async (failure) => {
  const { producer } = await fixture();
  const original = producer.overrideCall;
  producer.overrideCall = (name, args) => {
    if (
      name !== "lookup_funcs" ||
      queriesSchema.parse(args).queries.length === 1
    )
      return original?.(name, args);
    const rows = addresses.map(row);
    if (failure === "missing") return rows.slice(1);
    if (failure === "duplicate") return [rows[0]!, ...rows.slice(0, -1)];
    if (failure === "unrequested") return [row("0xdead"), ...rows.slice(1)];
    return [
      { query: addresses[0]!, fn: null, error: failure },
      ...rows.slice(1),
    ];
  };
  const runner = new IdaOperationRunner(producer, "modern", undefined, {
    x86Only: true,
  });
  await expect(
    runner.run("procedure_callees", { procedure: "main" }),
  ).rejects.toMatchObject({ _tag: "AnalysisProtocolError" });
});

it("propagates cancellation after the batch reply without reporting partial success", async () => {
  const { producer } = await fixture();
  const controller = new AbortController();
  producer.beforeCall = async (name, args) => {
    if (name === "lookup_funcs" && queriesSchema.parse(args).queries.length > 1)
      controller.abort();
  };
  const runner = new IdaOperationRunner(producer, "modern", undefined, {
    x86Only: true,
    signal: controller.signal,
  });
  await expect(
    runner.run("procedure_callees", { procedure: "main" }),
  ).rejects.toMatchObject({ _tag: "AnalysisCancelledError" });
  expect(producer.calls).toHaveLength(3);
  expect(runner.raw.at(-1)?.tool).toBe("lookup_funcs");
});

it.each([
  { mode: "headless", protocol: "modern" },
  { mode: "attached", protocol: "native" },
] as const)(
  "retains the correlated callee batch and upstream observations in the $mode session",
  async ({ mode, protocol }) => {
    const { producer, target, root } = await fixture(mode);
    const client = new IdaSessionClient(
      {
        command: "fixture",
        args: [],
        env: {},
        mode,
        protocol,
        timeoutMs: 1000,
        workspaceRoot: root,
      },
      target,
      producer,
    );
    try {
      const result = await client.execute("procedure_callees", {
        procedure: "main",
      });
      if (!result.ok) throw result.error;
      expect(result.value.result).toEqual(["0x9000", ...addresses]);
      expect(result.value.relationshipCoverage).toEqual(uncappedCalleeCoverage);
      if (mode === "headless")
        expect(producer.database).toEqual(expect.any(String));
      const scope = mode === "headless" ? { database: producer.database } : {};
      expect(
        producer.calls
          .filter(({ name }) => name === "lookup_funcs")
          .map(({ args }) => args),
      ).toEqual([
        { queries: ["main"], ...scope },
        { queries: addresses, ...scope },
      ]);
      expect(result.value.rawResult).toMatchObject({
        observations: [
          { tool: "lookup_funcs" },
          { tool: "callees" },
          {
            tool: "lookup_funcs",
            arguments: { queries: addresses, ...scope },
            result: addresses.map(row).reverse(),
          },
        ],
      });
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  },
);
