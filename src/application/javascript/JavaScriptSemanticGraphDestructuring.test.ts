import { expect, it } from "vitest";
import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";

it("links declared and assigned destructuring bindings to their exact source slots", () => {
  const cases = [
    { pattern: "{ a: selected }", source: "{ a: 1 }", path: ["a"] },
    { pattern: "[selected]", source: "[1]", path: ["0"] },
    {
      pattern: "{ a: [selected] = [] }",
      source: "{ a: [1] }",
      path: ["a", "0"],
    },
    {
      pattern: "{ a: { b: selected } = {} }",
      source: "{ a: { b: 1 } }",
      path: ["a", "b"],
    },
    { pattern: "[[selected] = []]", source: "[[1]]", path: ["0", "0"] },
  ];
  const graph = graphForJavaScript(
    cases
      .map(({ pattern, source }, index) =>
        [
          `const source${index} = ${source};`,
          `const ${pattern.replace("selected", `declared${index}`)} = source${index};`,
          `let assigned${index};`,
          `(${pattern.replace("selected", `assigned${index}`)} = source${index});`,
        ].join("\n"),
      )
      .join("\n"),
  );
  const nodes = new Map(graph.nodes.map((node) => [node.node_id, node]));
  expect(
    graph.relations
      .filter(({ relation }) => relation === "destructures")
      .map(({ source_node_id, target_node_id, resolution }) => ({
        target: nodes.get(target_node_id)?.label,
        path: nodes.get(source_node_id)?.properties.property_path,
        resolution,
      }))
      .sort((left, right) =>
        String(left.target).localeCompare(String(right.target)),
      ),
  ).toEqual(
    ["assigned", "declared"].flatMap((form) =>
      cases.map(({ path }, index) => ({
        target: `${form}${index}`,
        path,
        resolution: "resolved",
      })),
    ),
  );
});

it.each(["{}", "unknownSource"])(
  "keeps nested default source flow conservative for %s",
  (source) => {
    const graph = graphForJavaScript(
      `const source = ${source}; const { a: [selected] = [1] } = source;`,
    );
    const target = graph.nodes.find(
      (node) => node.kind === "binding" && node.label === "selected",
    );
    const relation = graph.relations.find(
      (item) =>
        item.relation === "destructures" &&
        item.target_node_id === target?.node_id,
    );
    expect(relation).toMatchObject({ resolution: "candidate" });
    expect(graph.unknowns).toContainEqual(
      expect.objectContaining({
        family: "object-flow",
        relation_kinds: ["destructures"],
      }),
    );
  },
);
