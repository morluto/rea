import { describe, expect, it } from "vitest";

import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import { buildCallPath } from "./callPath.js";
import {
  callPathInputSchema,
  callPathResultSchema,
} from "./callPathSchemas.js";
import { createEvidence, type Evidence } from "./evidence.js";
import { functionDossierSchema } from "./hopperValues.js";
import { jsonValueSchema } from "./jsonValue.js";

const observe = (
  address: string,
  callees: readonly string[],
  provider = "rea-workflow",
): Evidence => {
  const value = functionDossierSchema.parse({
    procedure: {
      address,
      name: `fn_${address.slice(2)}`,
      classification: null,
      body: {
        available: false,
        reason:
          "Hopper's public Python API does not expose complete function body ranges",
      },
      signature: null,
      locals: [],
    },
    pseudocode: "",
    assembly: [],
    comments: [],
    callers: [],
    callees: callees.map((callee) => ({
      address: callee,
      name: `fn_${callee.slice(2)}`,
      classification: null,
      body: {
        available: false,
        reason:
          "Hopper's public Python API does not expose complete function body ranges",
      },
    })),
    incoming_references: [],
    outgoing_references: [],
    referenced_strings: [],
    referenced_names: [],
    native_api: null,
    native_value_flow: null,
    basic_blocks: [],
    limitations: [],
  });
  return createEvidence(
    { path: "/tmp/a", sha256: "a".repeat(64), format: "mach-o" },
    { id: provider, name: provider, version: "1" },
    {
      operation: "analyze_function",
      parameters: enhancedInputSchemas.analyze_function.parse({
        procedure: address,
      }),
      result: jsonValueSchema.parse(value),
      confidence: "derived",
      authority: "shipped-artifact",
    },
  );
};

const run = (functions: Evidence[], overrides: Record<string, unknown> = {}) =>
  buildCallPath(
    callPathInputSchema.parse({
      functions,
      start: { address: "0x1000" },
      goal: { address: "0x4000" },
      ...overrides,
    }),
  );

describe("call path reconstruction", () => {
  it("returns deterministic shortest-first cited paths", () => {
    const result = run([
      observe("0x1000", ["0x3000", "0x2000"]),
      observe("0x2000", ["0x4000"]),
      observe("0x3000", ["0x5000"]),
      observe("0x5000", ["0x6000"]),
      observe("0x6000", ["0x4000"]),
    ]);
    expect(callPathResultSchema.parse(result)).toEqual(result);
    expect(result.status).toBe("found");
    expect(result.shortest_hops).toBe(2);
    expect(
      callPathResultSchema.safeParse({ ...result, shortest_hops: null })
        .success,
    ).toBe(false);
    expect(
      callPathResultSchema.safeParse({ ...result, paths: [] }).success,
    ).toBe(false);
    expect(
      result.paths.map((path) => path.nodes.map(({ address }) => address)),
    ).toEqual([["0x1000", "0x2000", "0x4000"]]);
    expect(
      result.paths[0]?.edges.every((edge) => edge.evidence_links.length > 0),
    ).toBe(true);
  });

  it("accepts a direct cited edge without a goal dossier", () => {
    const result = run([observe("0x1000", ["0x4000"])]);
    expect(result).toMatchObject({ status: "found", shortest_hops: 1 });
    expect(result.paths[0]?.nodes[1]).toMatchObject({
      address: "0x4000",
      name: null,
    });
  });

  it("only reports not_found for exhaustive closure", () => {
    const notFound = run([observe("0x1000", []), observe("0x4000", [])]);
    expect(notFound.status).toBe("not_found");
    expect(
      callPathResultSchema.safeParse({
        ...notFound,
        search_scope: { ...notFound.search_scope, exhaustive: false },
      }).success,
    ).toBe(false);
    const unknown = run([observe("0x1000", ["0x2000"])]);
    expect(unknown.status).toBe("unknown");
    expect(unknown.limitations).toContain(
      "No analyze_function Evidence covers reachable function 0x2000",
    );
  });

  it("searches the complete supplied graph", () => {
    expect(
      run([observe("0x1000", ["0x2000"]), observe("0x2000", [])]).status,
    ).toBe("not_found");
  });

  it("returns all shortest paths inline without paging", () => {
    const result = run([
      observe("0x1000", ["0x2000", "0x3000"]),
      observe("0x2000", ["0x4000"]),
      observe("0x3000", ["0x4000"]),
    ]);
    expect(result.paths.map((path) => path.nodes[1]?.address)).toEqual([
      "0x2000",
      "0x3000",
    ]);
  });
});

describe("call path topology and capacity", () => {
  it("retains every shortest path through merging branches and cycles", () => {
    const result = run([
      observe("0x1000", ["0x3000", "0x2000", "0x1000"]),
      observe("0x2000", ["0x3000", "0x5000", "0x6000"]),
      observe("0x3000", ["0x6000", "0x5000"]),
      observe("0x5000", ["0x4000", "0x1000"]),
      observe("0x6000", ["0x4000"]),
    ]);
    expect(
      result.paths.map(({ nodes }) => nodes.map(({ address }) => address)),
    ).toEqual([
      ["0x1000", "0x2000", "0x5000", "0x4000"],
      ["0x1000", "0x2000", "0x6000", "0x4000"],
      ["0x1000", "0x3000", "0x5000", "0x4000"],
      ["0x1000", "0x3000", "0x6000", "0x4000"],
    ]);
  });

  it("keeps uncovered dead ends in search limitations when a path is found", () => {
    const result = run([
      observe("0x1000", ["0x2000", "0x5000"]),
      observe("0x2000", ["0x4000"]),
    ]);
    expect(result).toMatchObject({
      status: "found",
      shortest_hops: 2,
      search_scope: { exhaustive: false },
      explored: { nodes: 4, edges: 3, depth_reached: 2 },
    });
    expect(result.limitations).toContain(
      "No analyze_function Evidence covers reachable function 0x5000",
    );
  });

  it("returns a zero-hop path when start and goal are the same function", () => {
    const result = run([observe("0x1000", ["0x2000"])], {
      goal: { address: "0x1000" },
    });
    expect(result).toMatchObject({
      status: "found",
      shortest_hops: 0,
      search_scope: { exhaustive: true },
    });
    expect(
      result.paths.map(({ nodes }) => nodes.map(({ address }) => address)),
    ).toEqual([["0x1000"]]);
  });

  it("reconstructs a deep function chain without exhausting the call stack", () => {
    const length = 20_000;
    const address = (index: number) => `0x${index.toString(16)}`;
    const functions = Array.from({ length }, (_, index) =>
      observe(address(index + 1), [address(index + 2)]),
    );
    const result = run(functions, {
      start: { address: address(1) },
      goal: { address: address(length + 1) },
    });
    expect(result).toMatchObject({ status: "found", shortest_hops: length });
    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.nodes).toHaveLength(length + 1);
    expect(result.paths[0]?.edges).toHaveLength(length);
    expect(result.paths[0]?.nodes.at(-1)?.address).toBe(address(length + 1));
  });

  it("returns the sole shortest path alongside a deep merging dead-end graph", () => {
    const stages = 28;
    const address = (index: number) => `0x${index.toString(16)}`;
    const functions = [observe("0x1", ["0x2", "0x1000"])];
    for (let index = 2; index < stages + 2; index += 1)
      functions.push(observe(address(index), [address(index + 1)]));
    for (let index = 0; index < stages; index += 1) {
      const base = 0x1000 + index * 2;
      const next = [address(base + 2), address(base + 3)];
      functions.push(observe(address(base), next));
      functions.push(observe(address(base + 1), next));
    }
    functions.push(observe(address(0x1000 + stages * 2), []));
    functions.push(observe(address(0x1001 + stages * 2), []));
    const result = run(functions, {
      start: { address: "0x1" },
      goal: { address: address(stages + 2) },
    });
    expect(result).toMatchObject({
      status: "found",
      shortest_hops: stages + 1,
      search_scope: { exhaustive: true },
    });
    expect(
      result.paths.map(({ nodes }) => nodes.map(({ address }) => address)),
    ).toEqual([
      Array.from({ length: stages + 2 }, (_, index) => address(index + 1)),
    ]);
  });
});

describe("call path evidence admission", () => {
  it("normalizes hex addresses and rejects duplicates and mixed providers", () => {
    expect(
      run([observe("0x001000", [])], {
        start: { address: "0X00001000" },
      }),
    ).toMatchObject({ status: "not_found", start: "0x1000" });
    expect(() =>
      run([observe("0x1000", [])], { start: { address: "1000" } }),
    ).toThrow();
    const one = observe("0x1000", []);
    expect(() => run([one, one])).toThrow(/Duplicate/u);
    expect(() => run([one, observe("0x2000", [], "other")])).toThrow(
      /providers/u,
    );
  });

  it("preserves address spaces and encoded names when normalizing offsets", () => {
    const result = run(
      [
        observe("0x1000", ["EXTERNAL:0x001000"]),
        observe("EXTERNAL:0x1000", ["overlay%3Atext:0x00004000"]),
      ],
      {
        goal: { address: "overlay%3Atext:0X004000" },
      },
    );
    expect(
      result.paths.map((path) => path.nodes.map(({ address }) => address)),
    ).toEqual([["0x1000", "EXTERNAL:0x1000", "overlay%3Atext:0x4000"]]);
    expect(() =>
      run([observe("0x1000", [])], {
        goal: { address: "overlay%ZZ:0x4000" },
      }),
    ).toThrow();
  });

  it("requires an observed start function", () => {
    expect(() => run([observe("0x2000", [])])).toThrow(
      /supplied for start 0x1000/u,
    );
  });
});
