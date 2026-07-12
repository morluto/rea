import { describe, expect, it } from "vitest";

import { enhancedInputSchemas } from "../src/contracts/enhancedInputs.js";
import {
  buildCallPath,
  callPathInputSchema,
  callPathResultSchema,
} from "../src/domain/callPath.js";
import { createEvidence, type Evidence } from "../src/domain/evidence.js";
import { functionDossierSchema } from "../src/domain/hopperValues.js";
import { jsonValueSchema } from "../src/domain/jsonValue.js";

const bounded = <Item>(items: readonly Item[], complete = true) => ({
  items,
  total: complete ? items.length : null,
  returned: items.length,
  truncated: !complete,
  next_offset: null,
});

const observe = (
  address: string,
  callees: readonly string[],
  complete = true,
  provider = "rea-workflow",
): Evidence => {
  const value = functionDossierSchema.parse({
    procedure: {
      address,
      name: `fn_${address.slice(2)}`,
      signature: null,
      locals: [],
    },
    pseudocode: {
      text: "",
      total_chars: 0,
      returned_chars: 0,
      truncated: false,
      next_offset: null,
    },
    assembly: bounded([]),
    comments: bounded([]),
    callers: bounded([]),
    callees: bounded(
      callees.map((callee) => ({
        address: callee,
        name: `fn_${callee.slice(2)}`,
      })),
      complete,
    ),
    incoming_references: bounded([]),
    outgoing_references: bounded([]),
    referenced_strings: bounded([]),
    referenced_names: bounded([]),
    basic_blocks: bounded([]),
    instruction_scan: { scanned: 0, truncated: false },
  });
  return createEvidence(
    { path: "/tmp/a", sha256: "a".repeat(64), format: "mach-o" },
    { id: provider, name: provider, version: "1" },
    {
      operation: "analyze_function",
      parameters: enhancedInputSchemas.analyze_function.parse({
        procedure: address,
        include_assembly: false,
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
      result.paths.items.map((path) =>
        path.nodes.map(({ address }) => address),
      ),
    ).toEqual([
      ["0x1000", "0x2000", "0x4000"],
      ["0x1000", "0x3000", "0x5000", "0x6000", "0x4000"],
    ]);
    expect(
      result.paths.items[0]?.edges.every(
        (edge) => edge.evidence_links.length > 0,
      ),
    ).toBe(true);
  });

  it("accepts a direct cited edge without a goal dossier", () => {
    const result = run([observe("0x1000", ["0x4000"])]);
    expect(result).toMatchObject({ status: "found", shortest_hops: 1 });
    expect(result.paths.items[0]?.nodes[1]).toMatchObject({
      address: "0x4000",
      name: null,
    });
  });

  it("only reports not_found for exhaustive closure", () => {
    expect(run([observe("0x1000", []), observe("0x4000", [])]).status).toBe(
      "not_found",
    );
    const unknown = run([observe("0x1000", ["0x2000"])]);
    expect(unknown.status).toBe("unknown");
    expect(unknown.limitations).toContain(
      "No analyze_function Evidence covers reachable function 0x2000",
    );
  });

  it("reports incomplete and depth-bounded absence as unknown", () => {
    expect(run([observe("0x1000", [], false)]).status).toBe("unknown");
    expect(
      run([observe("0x1000", ["0x2000"]), observe("0x2000", [])], {
        max_depth: 0,
      }).status,
    ).toBe("unknown");
  });

  it("truncates deterministically at max_paths and paginates retained paths", () => {
    const result = run(
      [
        observe("0x1000", ["0x2000", "0x3000"]),
        observe("0x2000", ["0x4000"]),
        observe("0x3000", ["0x4000"]),
      ],
      { max_paths: 1, offset: 0, limit: 1 },
    );
    expect(result.status).toBe("truncated");
    expect(result.paths).toMatchObject({
      total: null,
      returned: 1,
      truncated: true,
      lower_bound: 2,
    });
    expect(result.paths.items[0]?.nodes[1]?.address).toBe("0x2000");
  });

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
    expect(() => run([one, observe("0x2000", [], true, "other")])).toThrow(
      /providers/u,
    );
  });

  it("requires an observed start function", () => {
    expect(() => run([observe("0x2000", [])])).toThrow(
      /supplied for start 0x1000/u,
    );
  });
});
