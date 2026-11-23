import { expect, it } from "vitest";

import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";

it("records dynamic scope only at with and unshadowed direct eval", () => {
  const graph = graphForJavaScript(
    [
      "function inspect(host, source) {",
      "  with (host) { consume(target); }",
      "  eval(source);",
      "}",
      "function shadowed(eval, source) { eval(source); }",
      "function optional(source) { eval?.(source); }",
      "function indirect(source) { (0, eval)(source); }",
    ].join("\n"),
  );
  const inspect = graph.nodes.find(
    ({ label, kind }) => kind === "function" && label === "inspect",
  );
  if (inspect === undefined)
    throw new Error("Expected the containing function");
  const unknowns = graph.unknowns.filter(
    ({ reason }) => reason === "dynamic-scope",
  );
  expect(unknowns).toHaveLength(2);
  for (const [statement, line] of [
    ["with", 2],
    ["eval", 3],
  ] as const) {
    expect(unknowns).toContainEqual(
      expect.objectContaining({
        node_id: inspect.node_id,
        family: "data-flow",
        relation_kinds: ["reads", "writes"],
        detail: expect.stringContaining(`\`${statement}\``),
        evidence: expect.objectContaining({
          location: expect.objectContaining({
            available: true,
            value: expect.objectContaining({
              kind: "source-range",
              start: { line, column: 2 },
            }),
          }),
        }),
      }),
    );
  }
});
