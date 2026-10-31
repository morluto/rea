import { afterEach, describe, expect, it } from "vitest";
import type { JsonValue } from "../domain/jsonValue.js";
import { relationshipCoverageLimitations } from "../domain/relationshipCoverage.js";
import {
  callGraphSession,
  edge,
  graphRow,
  removeCallGraphSessions,
} from "../../tests/fixtures/idaCallGraph.js";

afterEach(removeCallGraphSessions);

const reference = (address: string, type = "code", caller = "0x2000") => ({
  addr: address,
  type,
  fn: { addr: caller, name: `caller_${caller}`, size: "0x20" },
});

const fixture = async (
  references: readonly JsonValue[],
  graphs: Readonly<Record<string, JsonValue>>,
  coverage: { readonly more?: boolean | undefined } = { more: false },
) => {
  const session = await callGraphSession({ callees: [] }, "x86_64");
  const original = session.producer.overrideCall;
  session.producer.overrideCall = (name, args) => {
    if (name === "xrefs_to")
      return [
        {
          xrefs: [...references],
          ...(coverage.more === undefined ? {} : { more: coverage.more }),
        },
      ];
    if (name === "callgraph") {
      const roots = Array.isArray(args.roots) ? args.roots.map(String) : [];
      return roots
        .flatMap((root) => {
          const graph = graphs[root];
          if (!Array.isArray(graph))
            throw new Error(`Unexpected candidate ${root}`);
          return graph;
        })
        .reverse();
    }
    return original?.(name, args);
  };
  return session;
};

const candidateGraph = (
  root: string,
  callsTarget: boolean,
  extra: Readonly<Record<string, JsonValue>> = {},
) =>
  graphRow(callsTarget ? [edge(root, "0x1000")] : [], {
    root,
    ...extra,
  });

describe("headless IDA verified callers", () => {
  it("confirms call edges, excludes jump-only/data references, and scans each candidate once", async () => {
    const { client, producer } = await fixture(
      [
        reference("0x2004"),
        reference("0x2008"),
        reference("0x3004", "code", "0x3000"),
        reference("0x4004", "data", "0x4000"),
      ],
      {
        "0x2000": candidateGraph("0x2000", true),
        "0x3000": candidateGraph("0x3000", false),
      },
    );
    try {
      const result = await client.execute("procedure_callers", {
        procedure: "main",
      });
      if (!result.ok) throw result.error;
      expect(result.value.result).toEqual(["0x2000"]);
      expect(result.value.relationshipCoverage?.status).toBe("partial");
      expect(
        relationshipCoverageLimitations(result.value.relationshipCoverage),
      ).toHaveLength(1);
      expect(
        producer.calls
          .filter(({ name }) => name === "callgraph")
          .map(({ args }) => args.roots),
      ).toEqual([["0x2000", "0x3000"]]);
      expect(producer.calls.some(({ name }) => name === "callees")).toBe(false);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("includes a recursive caller only when its self-call edge is proven", async () => {
    const { client } = await fixture([reference("0x1004", "code", "0x1000")], {
      "0x1000": candidateGraph("0x1000", true),
    });
    try {
      const result = await client.execute("procedure_callers", {
        procedure: "main",
      });
      if (!result.ok) throw result.error;
      expect(result.value.result).toEqual(["0x1000"]);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it.each([true, undefined])(
    "keeps observed callers partial when candidate coverage is %s",
    async (more) => {
      const { client } = await fixture(
        [reference("0x2004")],
        {
          "0x2000": candidateGraph("0x2000", true),
        },
        { more },
      );
      try {
        const result = await client.execute("procedure_callers", {
          procedure: "main",
        });
        if (!result.ok) throw result.error;
        expect(result.value.result).toEqual(["0x2000"]);
        expect(result.value.relationshipCoverage?.status).toBe("partial");
        expect(
          relationshipCoverageLimitations(result.value.relationshipCoverage),
        ).toHaveLength(2);
      } finally {
        expect((await client.close()).ok).toBe(true);
      }
    },
  );
});

describe("headless IDA caller batches", () => {
  it("verifies 1000 candidates with bounded roots and preserves reversed-row identities", async () => {
    const roots = Array.from(
      { length: 1000 },
      (_, i) => `0x${(0x2000 + i * 0x20).toString(16)}`,
    );
    const graphs = Object.fromEntries(
      roots.map((root) => [root, candidateGraph(root, true)]),
    );
    const { client, producer } = await fixture(
      roots.map((root) => reference(root, "code", root)),
      graphs,
    );
    try {
      const result = await client.execute("procedure_callers", {
        procedure: "main",
      });
      if (!result.ok) throw result.error;
      expect(result.value.result).toEqual(roots);
      const requests = producer.calls.filter(
        ({ name }) => name === "callgraph",
      );
      expect(requests).toHaveLength(32);
      expect(
        requests.every(
          ({ args }) => Array.isArray(args.roots) && args.roots.length <= 32,
        ),
      ).toBe(true);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it.each(["missing", "duplicate", "error"] as const)(
    "rejects %s batch rows",
    async (fault) => {
      const { client, producer } = await fixture(
        [reference("0x2004"), reference("0x3004", "code", "0x3000")],
        {},
      );
      const original = producer.overrideCall;
      producer.overrideCall = (name, args) =>
        name === "callgraph"
          ? [
              ...(candidateGraph("0x2000", true) as JsonValue[]),
              ...(fault === "missing"
                ? []
                : (candidateGraph(
                    fault === "duplicate" ? "0x2000" : "0x3000",
                    false,
                    fault === "error" ? { error: "producer failed" } : {},
                  ) as JsonValue[])),
            ]
          : original?.(name, args);
      try {
        const result = await client.execute("procedure_callers", {
          procedure: "main",
        });
        expect(result.ok).toBe(false);
      } finally {
        expect((await client.close()).ok).toBe(true);
      }
    },
  );
});

describe("headless IDA caller coverage and failures", () => {
  it("does not infer absence from a candidate's truncated graph", async () => {
    const { client } = await fixture([reference("0x2004")], {
      "0x2000": candidateGraph("0x2000", false, { truncated: true }),
    });
    try {
      const result = await client.execute("procedure_callers", {
        procedure: "main",
      });
      if (!result.ok) throw result.error;
      expect(result.value.result).toEqual([]);
      expect(result.value.relationshipCoverage?.status).toBe("partial");
      expect(
        relationshipCoverageLimitations(result.value.relationshipCoverage),
      ).toHaveLength(2);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("retains a confirmed caller even when the candidate graph omits other edges", async () => {
    const { client } = await fixture([reference("0x2004")], {
      "0x2000": candidateGraph("0x2000", true, { truncated: true }),
    });
    try {
      const result = await client.execute("procedure_callers", {
        procedure: "main",
      });
      if (!result.ok) throw result.error;
      expect(result.value.result).toEqual(["0x2000"]);
      expect(result.value.relationshipCoverage?.status).toBe("partial");
      expect(
        relationshipCoverageLimitations(result.value.relationshipCoverage),
      ).toHaveLength(1);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("keeps callers unavailable when upstream has no call graph tool", async () => {
    const { client, producer } = await fixture([], {});
    producer.tools = (await producer.connect()).filter(
      (name) => name !== "callgraph",
    );
    try {
      const result = await client.execute("procedure_callers", {
        procedure: "main",
      });
      if (result.ok) throw new Error("Expected unavailable callers");
      expect(result.error._tag).toBe("AnalysisCapabilityUnavailableError");
      expect(producer.calls.some(({ name }) => name === "xrefs_to")).toBe(
        false,
      );
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("keeps unowned code references unknown rather than returning complete absence", async () => {
    const { client } = await fixture(
      [{ addr: "0x2004", type: "code", fn: null }],
      {},
    );
    try {
      const result = await client.execute("procedure_callers", {
        procedure: "main",
      });
      if (!result.ok) throw result.error;
      expect(result.value.result).toEqual([]);
      expect(result.value.relationshipCoverage?.status).toBe("partial");
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("rejects a graph for the wrong candidate", async () => {
    const { client } = await fixture([reference("0x2004")], {
      "0x2000": candidateGraph("0x3000", true),
    });
    try {
      const result = await client.execute("procedure_callers", {
        procedure: "main",
      });
      expect(result.ok).toBe(false);
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });

  it("propagates cancellation during candidate verification", async () => {
    const { client, producer } = await fixture([reference("0x2004")], {
      "0x2000": candidateGraph("0x2000", true),
    });
    const controller = new AbortController();
    producer.beforeCall = async (name) => {
      if (name === "callgraph") controller.abort();
    };
    try {
      const result = await client.execute(
        "procedure_callers",
        { procedure: "main" },
        { signal: controller.signal },
      );
      if (result.ok) throw new Error("Expected cancellation");
      expect(result.error._tag).toBe("AnalysisCancelledError");
    } finally {
      expect((await client.close()).ok).toBe(true);
    }
  });
});
