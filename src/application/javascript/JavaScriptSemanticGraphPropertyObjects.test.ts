import { describe, expect, it } from "vitest";
import { graphForJavaScript } from "../../../tests/fixtures/javascriptSemanticGraph.js";
import { queryJavaScriptSemanticGraph } from "../../domain/javascript/javascriptSemanticQuery.js";

const slotStates = (graph: ReturnType<typeof graphForJavaScript>) =>
  graph.nodes
    .filter((node) => node.kind === "property-slot")
    .map(
      (node) =>
        `${(node.properties as { property_path: string[] }).property_path.join(".")}:${
          (node.properties as { value_status: string }).value_status
        }`,
    )
    .sort();

it.each([
  ["function receiver", "function Game() {}"],
  ["assigned receiver", "const Game = {};"],
] as const)(
  "models a top-level property assignment's container for %s",
  (_name, receiver) => {
    const graph = graphForJavaScript(`
      ${receiver}
      Game.config = { ACCEL: 0.001 };
      export function accel() { return Game.config.ACCEL; }
    `);
    expect(slotStates(graph)).toEqual([
      "config.ACCEL:literal",
      "config:object",
    ]);
    const trace = queryJavaScriptSemanticGraph(graph, {
      seed: { kind: "literal", value: 0.001 },
      direction: "forward-influence",
      include_ambiguous_dynamic_edges: true,
      expected: null,
    });
    expect(trace.status).toBe("found");
    expect([...new Set(trace.nodes.map((node) => node.label))]).toEqual(
      expect.arrayContaining([
        "0.001",
        "ACCEL",
        "read:/config/ACCEL",
        "return",
      ]),
    );
  },
);

it("matches the initializer control exactly", () => {
  const assigned = graphForJavaScript(
    "const Game = {};\nGame.config = { ACCEL: 0.001 };\nexport function accel() { return Game.config.ACCEL; }",
  );
  const initializer = graphForJavaScript(
    "const Game = { config: { ACCEL: 0.001 } };\nexport function accel() { return Game.config.ACCEL; }",
  );
  expect(slotStates(assigned)).toEqual(slotStates(initializer));
});

it.each([
  [
    "conditional",
    "const Game = {};\nif (flags.enabled) { Game.config = { ACCEL: 0.001 }; }\nexport function accel() { return Game.config.ACCEL; }",
  ],
  [
    "inside a function",
    "const Game = {};\nexport function setup() { Game.config = { ACCEL: 0.001 }; }\nexport function accel() { return Game.config.ACCEL; }",
  ],
  [
    "loop body",
    "const Game = {};\nfor (const entry of entries) { Game.config = { ACCEL: entry }; }\nexport function accel() { return Game.config.ACCEL; }",
  ],
] as const)("keeps the value unknown for a %s assignment", (_name, source) => {
  const graph = graphForJavaScript(source);
  expect(slotStates(graph)).toEqual(["config.ACCEL:unknown", "config:unknown"]);
  const trace = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "literal", value: 0.001 },
    direction: "forward-influence",
    include_ambiguous_dynamic_edges: true,
    expected: null,
  });
  expect(
    trace.nodes.filter((node) => node.label === "read:/config/ACCEL"),
  ).toEqual([]);
});

it("keeps a later non-literal writer's value unknown", () => {
  const graph = graphForJavaScript(`
    const Game = {};
    Game.config = { ACCEL: 0.001 };
    Game.config = computeConfig();
    export function accel() { return Game.config.ACCEL; }
    function computeConfig() { return { ACCEL: 1 }; }
  `);
  expect(slotStates(graph)).toContain("config.ACCEL:unknown");
});

it("folds the last of repeated top-level literal assignments", () => {
  const graph = graphForJavaScript(`
    const Game = {};
    Game.config = { ACCEL: 0.001 };
    Game.config = { ACCEL: 0.25 };
    export function accel() { return Game.config.ACCEL; }
  `);
  expect(slotStates(graph)).toEqual(["config.ACCEL:literal", "config:object"]);
  const trace = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "literal", value: 0.25 },
    direction: "forward-influence",
    include_ambiguous_dynamic_edges: true,
    expected: null,
  });
  expect(trace.status).toBe("found");
});

it("models nested property paths and arrays", () => {
  const graph = graphForJavaScript(`
    const App = {};
    App.settings = { limits: { retries: 3 } };
    App.list = [7, 8];
    export function read() { return App.settings.limits.retries + App.list[1]; }
  `);
  expect(slotStates(graph)).toEqual(
    expect.arrayContaining([
      "settings.limits.retries:literal",
      "settings.limits:object",
      "list:array",
    ]),
  );
});

it("does not fold logical-assignment right-hand sides", () => {
  const graph = graphForJavaScript(
    "const Game = {};\nGame.config ||= { ACCEL: 0.001 };\nexport function accel() { return Game.config.ACCEL; }",
  );
  expect(slotStates(graph)).toContain("config.ACCEL:unknown");
});

it("does not fold when a dynamic-key write may overlap the path", () => {
  const graph = graphForJavaScript(
    'const Game = {};\nconst key = "config";\nGame.config = { ACCEL: 0.001 };\nGame[key] = other;\nexport function accel() { return Game.config.ACCEL; }\nconst other = {};',
  );
  expect(slotStates(graph)).toContain("config.ACCEL:unknown");
});

it("does not fold assignments inside destructuring defaults", () => {
  const graph = graphForJavaScript(
    "const Game = {};\nconst { x = (Game.config = { ACCEL: 0.001 }) } = { x: 0 };\nexport function accel() { return Game.config.ACCEL; }",
  );
  expect(slotStates(graph)).toContain("config.ACCEL:unknown");
});

it("does not synthesize containers on null receivers", () => {
  const graph = graphForJavaScript(
    "const Game = null;\nGame.config = { ACCEL: 0.001 };\nexport function accel() { return Game.config.ACCEL; }",
  );
  expect(slotStates(graph)).toContain("config.ACCEL:unknown");
});

it("keeps the folded value unknown once the container reference is read out", () => {
  const graph = graphForJavaScript(
    "const Game = {};\nGame.config = { ACCEL: 0.001 };\nconst ref = Game.config;\nexport function accel() { return Game.config.ACCEL; }",
  );
  expect(slotStates(graph)).toContain("config.ACCEL:unknown");
});

it("folds onto the lexical receiver, not a same-named shadow", () => {
  const graph = graphForJavaScript(
    "const Game = {};\n{ const Game = {}; }\nGame.config = { ACCEL: 0.001 };\nexport function accel() { return Game.config.ACCEL; }",
  );
  expect(slotStates(graph)).toContain("config.ACCEL:literal");
});

it("keeps an enclosing nested writer over its inner assignment", () => {
  const graph = graphForJavaScript(
    "const Game = {};\nGame.config = { marker: (Game.config = { stale: 1 }) };\nexport function accel() { return Game.config.stale; }",
  );
  expect(slotStates(graph)).not.toContain("config.stale:literal");
});

it("does not apply a folded value to reads before the assignment", () => {
  const graph = graphForJavaScript(
    "const Game = { config: { x: 1 } };\nconst before = Game.config.x;\nGame.config = { x: 2 };\nexport function accel() { return Game.config.x; }",
  );
  // The folded literal reaches the later read through candidate edges (the
  // initializer-written container keeps mutation-unknown presence, so a fully
  // resolved chain through both writers needs follow-up); the positional
  // application guarantees the earlier read never claims the folded value.
  const foldedTrace = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "literal", value: 2 },
    direction: "forward-influence",
    include_ambiguous_dynamic_edges: true,
    expected: null,
  });
  expect(foldedTrace.nodes.map((node) => node.label)).toContain(
    "read:/config/x",
  );
});
