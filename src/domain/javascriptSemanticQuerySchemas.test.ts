import { expect, it } from "vitest";

import {
  javaScriptSemanticQueryInputSchema,
  javaScriptSemanticQueryResultSchema,
} from "./javascriptSemanticQuerySchemas.js";

it("accepts long selectors and complete relation and class selections", () => {
  const longText = "x".repeat(16_385);
  const result = javaScriptSemanticQueryInputSchema.parse({
    seed: { kind: "endpoint", value: longText },
    direction: "forward-influence",
    allowed_relations: Array(2).fill("calls"),
    expected: {
      role: "sink",
      classes: Array(25).fill("module"),
    },
  });

  expect(result.seed).toEqual({ kind: "endpoint", value: longText });
  expect(result.allowed_relations).toHaveLength(2);
  expect(result.expected?.classes).toHaveLength(25);
});

it("rejects the inert source-map authority setting", () => {
  expect(
    javaScriptSemanticQueryInputSchema.safeParse({
      seed: { kind: "endpoint", value: "/api" },
      direction: "forward-influence",
      source_map_authority: { authority: "none" },
    }).success,
  ).toBe(false);
});

it("accepts every reported limitation without a count ceiling", () => {
  const limitations = Array.from(
    { length: 1_001 },
    (_, index) => `gap-${index}`,
  );
  const id = "a".repeat(64);

  const result = javaScriptSemanticQueryResultSchema.parse({
    query_id: `jsrq_${id}`,
    source_graph_id: `jsrg_${id}`,
    seed: { kind: "literal", value: null },
    direction: "forward-influence",
    status: "no-match",
    seed_node_ids: [],
    nodes: [],
    relations: [],
    unknowns: [],
    expected_match_node_ids: [],
    summary: {
      total_seed_matches: 0,
      traversed_nodes: 0,
      traversed_relations: 0,
      traversed_functions: 0,
      traversed_modules: 0,
      relevant_unknowns: 0,
    },
    coverage: { status: "complete" },
    limitations,
  });

  expect(result.limitations).toHaveLength(1_001);
});
