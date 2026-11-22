import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createIdaTarget,
  RecordingIdaMcp,
} from "../../tests/fixtures/idaMcp.js";
import {
  callGraphSession as session,
  edge,
  graphRow,
  removeCallGraphSessions,
} from "../../tests/fixtures/idaCallGraph.js";
import { IDA_LIMITATIONS } from "./IdaProviderCapabilities.js";
import { IdaSessionClient } from "./IdaSessionClient.js";

const attachedRoots: string[] = [];
afterEach(async () => {
  await removeCallGraphSessions();
  for (const root of attachedRoots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const observedTools = (rawResult: unknown): string[] =>
  z
    .object({ observations: z.array(z.object({ tool: z.string() })) })
    .parse(rawResult)
    .observations.map(({ tool }) => tool);

const callees = async (client: IdaSessionClient) => {
  const result = await client.execute("procedure_callees", {
    procedure: "main",
  });
  if (!result.ok) throw result.error;
  return result.value;
};

describe("headless IDA call graph availability and cancellation", () => {
  it("takes the call graph path for a universal target whose loaded slice is unknown", async () => {
    const { client, producer } = await session(
      { callees: [], callgraph: graphRow([edge("0x1000", "0x2000")]) },
      "x86_64",
      ["x86_64", "arm64"],
    );
    try {
      const execution = await callees(client);

      expect(execution.result, "the graph edge is observed").toEqual([
        "0x2000",
      ]);
      expect(
        producer.calls.some(({ name }) => name === "callgraph"),
        "a mixed universal target cannot prove an x86 slice",
      ).toBe(true);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("stops at once when the caller cancels during the call graph request", async () => {
    const controller = new AbortController();
    const { client, producer } = await session({
      callees: [],
      callgraph: graphRow([edge("0x1000", "0x2000")]),
    });
    const inner = producer.beforeCall;
    producer.beforeCall = async (name, args) => {
      await inner?.(name, args);
      if (name === "callgraph") controller.abort();
    };
    try {
      const result = await client.execute(
        "procedure_callees",
        { procedure: "main" },
        { signal: controller.signal },
      );

      if (result.ok) throw new Error("expected cancellation");
      expect(result.error._tag, "cancellation is not swallowed").toBe(
        "AnalysisCancelledError",
      );
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });
});

describe("headless IDA callee edges on x86 targets", () => {
  it.each([
    {
      label: "external and internal callees",
      rows: [
        { addr: "0x2000", name: "imported_puts", type: "external" },
        { addr: "0x3000", name: "printf_stub", type: "internal" },
      ],
      addresses: ["0x2000", "0x3000"],
      tools: ["lookup_funcs", "callees", "lookup_funcs"],
    },
    {
      label: "an explicitly complete empty reply",
      rows: [],
      addresses: [],
      tools: ["lookup_funcs", "callees"],
    },
  ])(
    "reads only the x86 callee source for $label",
    async ({ rows, addresses, tools }) => {
      const { client, producer } = await session({ callees: rows }, "x86_64");
      try {
        const execution = await callees(client);

        expect(execution.result).toEqual(addresses);
        expect(execution.relationshipCoverage).toMatchObject({
          status: "complete",
        });
        expect(execution.limitations).toEqual([...IDA_LIMITATIONS]);
        expect(
          producer.calls.filter(({ name }) => name === "callees"),
        ).toMatchObject([{ args: { addrs: ["0x1000"], limit: 500 } }]);
        expect(observedTools(execution.rawResult)).toEqual(tools);
      } finally {
        expect((await client.close()).ok).toBe(true);
      }
    },
  );

  it("does not use the call graph for the native attached profile on an ARM target", async () => {
    const { root, target } = await createIdaTarget("arm64");
    attachedRoots.push(root);
    const producer = new RecordingIdaMcp(target, "attached");
    const client = new IdaSessionClient(
      {
        command: "fixture",
        args: [],
        env: {},
        mode: "attached",
        protocol: "native",
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

      expect(result.ok, "the native read still works").toBe(true);
      expect(
        producer.calls.some(({ name }) => name === "callgraph"),
        "the native profile reads upstream callees, not the call graph",
      ).toBe(false);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });
});
