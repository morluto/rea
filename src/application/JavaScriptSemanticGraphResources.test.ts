import { expect, it } from "vitest";

import { buildJavaScriptSemanticGraph } from "./JavaScriptSemanticGraphBuilder.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import { queryJavaScriptSemanticGraph } from "../domain/javascriptSemanticQuery.js";
import { analyzeJavaScriptSemantics } from "../domain/javascriptSemanticAnalysis.js";
import {
  DEFAULT_JAVASCRIPT_SEMANTIC_LIMITS,
  type JavaScriptSemanticLimits,
} from "../domain/javascriptSemanticIr.js";

const SHA256 = "a".repeat(64);
const GRAPH_ID = `jag_${"b".repeat(64)}`;

it("projects literal events and exact timer cancellation", () => {
  const graph = graphFor(`
      function run(bus, dynamicName) {
        const handle = setInterval(tick, 10);
        bus.on("ready", handler);
        bus.once(dynamicName, handler);
        bus.emit("ready");
        bus.removeListener("ready", handler);
        clearInterval(handle);
      }
    `);

  const relations = new Set(graph.relations.map(({ relation }) => relation));
  for (const expected of [
    "cancels-timer",
    "dispatches-candidate",
    "registers-listener",
    "removes-listener",
    "schedules-timer",
  ] as const)
    expect(relations.has(expected)).toBe(true);
  expect(
    graph.nodes.find(
      ({ kind, properties }) =>
        kind === "event" && properties.event_name === "ready",
    ),
  ).toBeDefined();
  expect(
    graph.unknowns.some(
      ({ family, detail }) =>
        family === "event" && detail.includes("Dynamic once event name"),
    ),
  ).toBe(true);
  expect(
    graph.coverage.families.find(({ family }) => family === "event"),
  ).toMatchObject({ status: "partial" });
  expect(
    graph.coverage.families.find(({ family }) => family === "timer"),
  ).toMatchObject({ status: "partial" });
});

it("projects child-process creation, I/O, listeners, and signals", () => {
  const graph = graphFor(`
      import { spawn } from "node:child_process";
      function run(command) {
        const child = spawn(
          command,
          ["--mode", "fast"],
          { env: process.env, stdio: "pipe" },
        );
        child.on("exit", onExit);
        child.once("error", onError);
        child.kill("SIGTERM");
      }
    `);

  const relations = new Set(graph.relations.map(({ relation }) => relation));
  for (const expected of [
    "connects-stdio",
    "forwards-signal",
    "listens-error",
    "listens-exit",
    "spawns",
    "supplies-argv",
    "supplies-env",
  ] as const)
    expect(relations.has(expected)).toBe(true);
  expect(
    graph.nodes.find(
      ({ kind, properties }) =>
        kind === "child-process" &&
        properties.method === "spawn" &&
        properties.command === null,
    ),
  ).toBeDefined();
  expect(
    graph.unknowns.some(
      ({ family, detail }) =>
        family === "child-process" &&
        detail.includes("command remains unresolved"),
    ),
  ).toBe(true);
  expect(
    graph.coverage.families.find(({ family }) => family === "child-process"),
  ).toMatchObject({ status: "partial" });
});

it("projects config precedence, request fields, and boundaries", () => {
  const graph = graphFor(`
      import { readFileSync } from "node:fs";
      async function run(schema) {
        const endpoint = process.env.API_URL ?? "https://fallback.test";
        const raw = readFileSync("./config.json", "utf8");
        const parsed = JSON.parse(raw);
        const port = Number(process.argv[2]);
        const validated = schema.parse(parsed);
        const response = await fetch(endpoint, {
          method: "POST",
          body: validated,
        });
        return response.json();
      }
    `);

  const relations = new Set(graph.relations.map(({ relation }) => relation));
  for (const expected of [
    "coerces",
    "constructs-request",
    "consumed-by",
    "defaults",
    "overrides",
    "parses",
    "reads-argv",
    "reads-config",
    "reads-environment",
    "supplies-request-field",
  ] as const)
    expect(relations.has(expected)).toBe(true);
  expect(
    graph.nodes.find(
      ({ kind, properties }) =>
        kind === "request" && properties.method === "fetch",
    ),
  ).toBeDefined();
  expect(
    graph.nodes.filter(({ kind }) => kind === "boundary"),
  ).not.toHaveLength(0);
  expect(
    graph.coverage.families.find(({ family }) => family === "configuration"),
  ).toMatchObject({ status: "partial" });
  expect(
    graph.coverage.families.find(({ family }) => family === "request"),
  ).toMatchObject({ status: "partial" });
  expect(
    graph.coverage.families.find(({ family }) => family === "boundary"),
  ).toMatchObject({ status: "partial" });
});

it("projects built-in resource acquisition and release", () => {
  const graph = graphFor(`
      import { open } from "node:fs/promises";
      import { connect } from "node:net";
      async function run(path) {
        const file = await open(path);
        const socket = connect({ port: 9000 });
        await file.close();
        socket.end();
      }
    `);

  const relations = new Set(graph.relations.map(({ relation }) => relation));
  expect(relations.has("acquires")).toBe(true);
  expect(relations.has("releases")).toBe(true);
  expect(graph.nodes.filter(({ kind }) => kind === "resource")).toHaveLength(2);
  expect(
    graph.coverage.families.find(
      ({ family }) => family === "resource-lifecycle",
    ),
  ).toMatchObject({ status: "partial" });
});

it("projects literal seeds and static object flow", () => {
  const graph = graphFor(`
      const source = { token: "TOKEN", count: 1 };
      const { token } = source;
      const copy = { ...source };
      source.count = 2;
      const read = source.token;
    `);

  const relations = new Set(graph.relations.map(({ relation }) => relation));
  for (const expected of [
    "destructures",
    "reads-property",
    "spreads",
    "writes-property",
  ] as const)
    expect(relations.has(expected)).toBe(true);
  expect(
    graph.nodes.find(
      ({ kind, properties }) =>
        kind === "property-slot" && properties.name === "token",
    ),
  ).toBeDefined();
  const literal = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "literal", value: "TOKEN" },
    direction: "forward-influence",
  });
  expect(literal.status).toBe("ambiguous");
  expect(literal.summary.total_seed_matches).toBe(3);
  const property = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "property", name: "token" },
    direction: "forward-influence",
  });
  expect(property.status).toBe("found");
});

it("does not promote transformed return expressions to resolved aliases", () => {
  const graph = graphFor(`
      function increment(value) { return value + 1; }
      const input = 1;
      const output = increment(input);
    `);
  const returnNode = graph.nodes.find(({ kind }) => kind === "return-site");
  if (returnNode === undefined) throw new Error("Expected return site");
  expect(
    graph.relations.filter(
      ({ relation, target_node_id }) =>
        relation === "aliases" && target_node_id === returnNode.node_id,
    ),
  ).toEqual([expect.objectContaining({ resolution: "candidate" })]);
  const output = graph.nodes.find(
    ({ kind, label }) => kind === "binding" && label === "output",
  );
  const input = graph.nodes.find(
    ({ kind, label }) => kind === "binding" && label === "input",
  );
  if (output === undefined || input === undefined)
    throw new Error("Expected caller bindings");
  const strict = queryJavaScriptSemanticGraph(graph, {
    seed: { kind: "semantic-node", node_id: output.node_id },
    direction: "backward-provenance",
  });
  expect(strict.nodes.map(({ node_id }) => node_id)).not.toContain(
    input.node_id,
  );
  expect(strict.status).toBe("ambiguous");
});

it("uses unavailable evidence when no source produced semantic IR", () => {
  const graph = buildJavaScriptSemanticGraph({
    rootArtifactSha256: SHA256,
    applicationGraph: { graph_id: GRAPH_ID, nodes: [] },
    analysis: emptyAnalysis(),
  });
  expect(graph.nodes).toHaveLength(1);
  expect(graph.nodes[0]?.evidence).toMatchObject({
    authority: "unknown",
    state: "unavailable",
    location: { available: false, reason: "not-observed" },
  });
});

const emptyAnalysis = (): JavaScriptArtifactAnalysis => ({
  files: [],
  packages: [],
  json_modules: [],
  html_scripts: [],
  source_maps: [],
  visited_ast_nodes: 0,
  findings: 0,
  modules: 0,
  parse_failures: 0,
  truncated_scopes: 0,
  limitations: [],
});

const graphFor = (
  source: string,
  inputLimits: Partial<JavaScriptSemanticLimits> = {},
) => {
  const file: JavaScriptArtifactFile = {
    path: "app.js",
    container_sha256: SHA256,
    sha256: SHA256,
    bytes: Buffer.byteLength(source),
    inventory_artifact_id: `art_${SHA256}`,
    kind: "javascript",
    unpacked: false,
    text: { included: true, value: source },
  };
  const semanticLimits = {
    ...DEFAULT_JAVASCRIPT_SEMANTIC_LIMITS,
    ...inputLimits,
  };
  const analysis: JavaScriptArtifactAnalysis = {
    files: [
      {
        file,
        javascript: null,
        semantic: {
          ir: analyzeJavaScriptSemantics(source, inputLimits),
          limits: semanticLimits,
        },
      },
    ],
    packages: [],
    json_modules: [],
    html_scripts: [],
    source_maps: [],
    visited_ast_nodes: 0,
    findings: 0,
    modules: 0,
    parse_failures: 0,
    truncated_scopes: 0,
    limitations: [],
  };
  return buildJavaScriptSemanticGraph({
    rootArtifactSha256: SHA256,
    applicationGraph: { graph_id: GRAPH_ID, nodes: [] },
    analysis,
  });
};
