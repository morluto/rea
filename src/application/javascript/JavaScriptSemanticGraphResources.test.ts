import { javaScriptSemanticQueryInputSchema } from "../../domain/javascript/javascriptSemanticQuerySchemas.js";
import { expect, it } from "vitest";

import { graphForJavaScript as graphFor } from "../../../tests/fixtures/javascriptSemanticGraph.js";
import { createJavaScriptSemanticGraphProjection } from "./JavaScriptSemanticGraphBuilder.js";
import { queryJavaScriptSemanticGraph } from "../../domain/javascript/javascriptSemanticQuery.js";
import { resolveJavaScriptSemanticEvidence } from "../../../tests/support/javascriptSemanticGraphFixture.js";

const SHA256 = "a".repeat(64);
const GRAPH_ID = `jag_${"b".repeat(64)}`;

it("retains an uncertain stream acquisition and release as candidates", () => {
  const graph = graphFor(`
    const fs = require("node:fs");
    Object.defineProperty(fs, "ReadStream", { value: Custom });
    const stream = fs.createReadStream("input", { start: -1 });
    stream.close();
  `);
  expect(graph.relations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relation: "acquires",
        resolution: "candidate",
      }),
      expect.objectContaining({
        relation: "releases",
        resolution: "candidate",
      }),
    ]),
  );
  expect(graph.unknowns).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        family: "resource-lifecycle",
        relation_kinds: ["acquires"],
      }),
      expect.objectContaining({
        family: "resource-lifecycle",
        relation_kinds: ["releases"],
      }),
    ]),
  );
});

it("keeps literal event links and dynamic event uncertainty", () => {
  const graph = graphFor(`
      function run(bus, dynamicName) {
        bus.on("ready", handler);
        bus.once(dynamicName, handler);
        bus.emit("ready");
        bus.removeListener("ready", handler);
      }
    `);

  const relations = new Set(graph.relations.map(({ relation }) => relation));
  for (const expected of [
    "dispatches-candidate",
    "registers-listener",
    "removes-listener",
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

  const child = graph.nodes.find(({ kind }) => kind === "child-process");
  if (child === undefined) throw new Error("Expected the spawned child");
  expect(child.properties).toMatchObject({
    method: "spawn",
    command: null,
    argv_count: 2,
    environment_supplied: true,
    stdio_mode: "pipe",
  });
  expect(
    graph.relations
      .filter(({ target_node_id }) => target_node_id === child.node_id)
      .map(({ relation }) => relation),
  ).toEqual(
    expect.arrayContaining([
      "forwards-signal",
      "spawns",
      "supplies-argv",
      "supplies-env",
    ]),
  );
  expect(
    graph.relations
      .filter(({ source_node_id }) => source_node_id === child.node_id)
      .map(({ relation }) => relation),
  ).toEqual(
    expect.arrayContaining(["connects-stdio", "listens-error", "listens-exit"]),
  );
  expect(graph.unknowns).toContainEqual(
    expect.objectContaining({
      node_id: child.node_id,
      family: "child-process",
      detail: expect.stringContaining("command remains unresolved"),
    }),
  );
  expect(
    graph.coverage.families.find(({ family }) => family === "child-process"),
  ).toMatchObject({ status: "partial" });
});

it("keeps destructured request, spawn, and timer results as projections", () => {
  const graph = graphFor(`
      import { spawn } from "node:child_process";
      async function run() {
        const { data } = await fetch("https://example.test");
        const [ child ] = spawn("worker", []);
        child.on("exit", done);
        const { handle } = setTimeout(done, 5);
        clearTimeout(handle);
        return data.json();
      }
    `);
  const projections = graph.relations.filter(
    ({ relation }) => relation === "destructures",
  );
  expect(
    projections.map(({ properties }) => properties.projection_path),
  ).toEqual(expect.arrayContaining([["data"], [0], ["handle"]]));
  expect(
    projections.every(
      ({ properties }) => properties.projection_resolution === "complete",
    ),
  ).toBe(true);
  expect(
    graph.relations.find(
      ({ relation, properties }) =>
        relation === "consumed-by" && properties.method === "json",
    ),
  ).toMatchObject({ resolution: "candidate" });
  expect(
    graph.relations.find(({ relation }) => relation === "listens-exit"),
  ).toMatchObject({ resolution: "candidate" });
  expect(
    graph.relations.find(({ relation }) => relation === "cancels-timer"),
  ).toMatchObject({ resolution: "candidate" });
  expect(
    graph.relations.some(
      ({ relation, resolution }) =>
        ["consumed-by", "listens-exit", "cancels-timer"].includes(relation) &&
        resolution === "resolved",
    ),
  ).toBe(false);
});

it("does not alias nested call arguments to an outer assigned result", () => {
  const graph = graphFor(`
      import { spawn } from "node:child_process";
      function run() {
        const child = wrap(spawn("worker", []));
        child.on("exit", done);
        const handle = String(setTimeout(done, 5));
        clearTimeout(handle);
      }
    `);
  expect(
    graph.relations.some(({ relation }) =>
      ["listens-exit", "cancels-timer", "destructures"].includes(relation),
    ),
  ).toBe(false);
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

it("links the read and write of each update to the same property slot", () => {
  const graph = graphFor(`
    const source = { count: 1, total: 2 };
    source.count += 1;
    source.total++;
  `);
  for (const path of ["count", "total"]) {
    const slot = graph.nodes.find(
      ({ kind, properties }) =>
        kind === "property-slot" && properties.property_pointer === `/${path}`,
    );
    if (slot === undefined) throw new Error(`Expected the ${path} slot`);
    const updates = graph.nodes.filter(
      ({ properties }) =>
        Array.isArray(properties.property_path) &&
        properties.property_path[0] === path,
    );
    const read = updates.find(
      ({ properties }) => properties.operation_kind === "read",
    );
    const write = updates.find(
      ({ properties }) => properties.operation_kind === "write",
    );
    if (read === undefined || write === undefined)
      throw new Error(`Expected both operations for ${path}`);
    expect(graph.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relation: "reads-property",
          source_node_id: slot.node_id,
          target_node_id: read.node_id,
        }),
        expect.objectContaining({
          relation: "writes-property",
          source_node_id: write.node_id,
          target_node_id: slot.node_id,
        }),
      ]),
    );
  }
});

it("does not project a literal property slot for dynamic destructuring", () => {
  const graph = graphFor(`
    const source = { token: "TOKEN" };
    const key = getKey();
    const { [key]: value } = source;
  `);

  expect(
    graph.relations.filter(({ relation }) => relation === "destructures"),
  ).toEqual([]);
  expect(
    graph.nodes.find(
      ({ kind, properties }) =>
        kind === "property-slot" && properties.name === "key",
    ),
  ).toBeUndefined();
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
  const literal = queryJavaScriptSemanticGraph(
    graph,
    javaScriptSemanticQueryInputSchema.parse({
      seed: { kind: "literal", value: "TOKEN" },
      direction: "forward-influence",
    }),
  );
  expect(literal.status).toBe("ambiguous");
  const targetName = (targetId: string): string => {
    const target = graph.nodes.find(({ node_id }) => node_id === targetId);
    if (target === undefined) throw new Error("Missing value target");
    if (target.kind === "binding" && target.label !== null) return target.label;
    const owner = graph.relations.find(
      ({ relation, target_node_id }) =>
        relation === "writes-property" && target_node_id === target.node_id,
    );
    const binding = graph.nodes.find(
      ({ node_id }) => node_id === owner?.source_node_id,
    );
    if (binding === undefined) throw new Error("Missing property owner");
    return `${binding.label}.${String(target.properties.name)}`;
  };
  const literalTargets = graph.relations
    .filter(
      ({ relation, source_node_id }) =>
        relation === "defines" &&
        literal.seed_node_ids.includes(source_node_id),
    )
    .map(({ target_node_id }) => targetName(target_node_id));
  expect(literalTargets.sort()).toEqual([
    "copy.token",
    "read",
    "source.token",
    "token",
  ]);
  expect(literal.summary.total_seed_matches).toBe(literalTargets.length);
  const property = queryJavaScriptSemanticGraph(
    graph,
    javaScriptSemanticQueryInputSchema.parse({
      seed: { kind: "property", name: "token" },
      direction: "forward-influence",
    }),
  );
  expect(property.status).toBe("ambiguous");
  expect(property.seed_node_ids.map(targetName).sort()).toEqual([
    "copy.token",
    "source.token",
  ]);
  expect(property.unknowns).toEqual([]);
  expect(property.relations).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        relation: "destructures",
        resolution: "resolved",
      }),
      expect.objectContaining({
        relation: "reads-property",
        resolution: "resolved",
      }),
    ]),
  );
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
  ).toEqual([]);
  expect(
    graph.relations.filter(
      ({ relation, target_node_id }) =>
        relation === "influences" && target_node_id === returnNode.node_id,
    ),
  ).toEqual([expect.objectContaining({ resolution: "resolved" })]);
  const output = graph.nodes.find(
    ({ kind, label }) => kind === "binding" && label === "output",
  );
  const input = graph.nodes.find(
    ({ kind, label }) => kind === "binding" && label === "input",
  );
  if (output === undefined || input === undefined)
    throw new Error("Expected caller bindings");
  const strict = queryJavaScriptSemanticGraph(
    graph,
    javaScriptSemanticQueryInputSchema.parse({
      seed: { kind: "semantic-node", node_id: output.node_id },
      direction: "backward-provenance",
    }),
  );
  expect(strict.nodes.map(({ node_id }) => node_id)).toContain(input.node_id);
  expect(strict.status).toBe("partial");
});

it("uses unavailable evidence when no source produced semantic IR", () => {
  const graph = createJavaScriptSemanticGraphProjection().finish(SHA256, {
    graph_id: GRAPH_ID,
    nodes: [],
  });
  const root = graph.nodes[0];
  if (root === undefined) throw new Error("Expected unavailable semantic root");
  expect(resolveJavaScriptSemanticEvidence(graph, root.evidence)).toMatchObject(
    {
      authority: "unknown",
      state: "unavailable",
      location: { available: false, reason: "not-observed" },
    },
  );
});

it("retains conditional Node timer and child effects without proving a loader", () => {
  const graph = graphFor(`
    const { spawn } = require('child_process');
    const { setTimeout } = require('timers');
    const child = spawn('tool', []); child.kill();
    setTimeout(() => {}, 1);
  `);
  const child = graph.nodes.find((node) => node.kind === "child-process");
  const timer = graph.nodes.find((node) => node.kind === "timer");
  for (const node of [child, timer]) {
    expect(node?.properties.builtin_authority).toBe("candidate");
    if (node === undefined) throw new Error("Expected candidate node");
    expect(
      resolveJavaScriptSemanticEvidence(graph, node.evidence),
    ).toMatchObject({ state: "inferred", confidence: "low" });
  }
  for (const kind of [
    "spawns",
    "schedules-timer",
    "forwards-signal",
  ] as const) {
    const relation = graph.relations.find((item) => item.relation === kind);
    expect(relation).toMatchObject({ resolution: "candidate" });
    if (relation === undefined) throw new Error(`Expected ${kind} relation`);
    expect(
      resolveJavaScriptSemanticEvidence(graph, relation.evidence),
    ).toMatchObject({ state: "inferred", confidence: "low" });
  }
});
