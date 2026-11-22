import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "../../domain/javascript/javascriptSemanticAnalysis.js";
import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";

const projection = (source: string) => {
  const ir = analyzeJavaScriptSemantics(source);
  const graph = graphForJavaScript(source, ir);
  return (name: string) => {
    const binding = graph.nodes.find(
      ({ kind, label }) => kind === "binding" && label === name,
    );
    const relation = graph.relations.find(
      ({ relation: kind, target_node_id }) =>
        kind === "destructures" && target_node_id === binding?.node_id,
    );
    return {
      resolution: relation?.resolution,
      value: ir.bindings.find((item) => item.name === name)?.value,
      sourcePath: graph.nodes.find(
        ({ node_id }) => node_id === relation?.source_node_id,
      )?.properties.property_path,
    };
  };
};

it.each([
  ["null", "{}"],
  ["undefined", "{}"],
  ["void 0", "{}"],
  ["null", "[]"],
  ["null", "{} = {}"],
  ["undefined", "{} = null"],
  ["void 0", "[] = undefined"],
  ["aliasedNull", "{} = {}"],
  ["undefined", "{} = aliasedNull"],
  ["null", "{}", '["bad"]'],
  ["captured", "{}", "bad", "captured = {};"],
] as const)(
  "leaves bindings after %s matched against %s unproven",
  (value, pattern, key = "bad", afterCapture?: string) => {
    const inspect = projection(`
    const aliasedNull = null;
    let captured = null;
    const model = { bad: ${value}, mode: "one" };
    ${afterCapture ?? ""}
    const { mode: before, ${key}: ${pattern}, mode: selected } = model;
  `);
    expect(inspect("before")).toMatchObject({
      resolution: "resolved",
      sourcePath: ["mode"],
    });
    expect(inspect("selected")).toMatchObject({
      resolution: "candidate",
      value: { status: "unknown" },
      sourcePath: ["mode"],
    });
  },
);

it.each([
  ["const model = { bad: 0, mode: 'one' };", "{}"],
  ["const model = { bad: {}, mode: 'one' };", "{}"],
  ["const model = { bad: [], mode: 'one' };", "[]"],
  ["const model = { bad: undefined, mode: 'one' };", "{} = {}"],
  ["const model = { bad: 0, mode: 'one' };", "{} = null"],
  ["const undefined = 0; const model = { bad: undefined, mode: 'one' };", "{}"],
  [
    "let captured = {}; const model = { bad: captured, mode: 'one' }; captured = null;",
    "{}",
  ],
] as const)(
  "preserves the reachable sibling for %s against %s",
  (setup, pattern) => {
    const inspect = projection(`
    ${setup}
    const { bad: ${pattern}, mode: selected } = model;
  `);
    expect(inspect("selected")).toMatchObject({
      resolution: "resolved",
      value: { status: "literal", value: "one" },
      sourcePath: ["mode"],
    });
  },
);
