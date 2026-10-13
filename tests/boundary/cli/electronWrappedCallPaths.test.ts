import { expect } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeFixtureFiles } from "../../support/javascriptApplicationFixture.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { applicationFeatureTraceResultSchema } from "../../../src/domain/javascript/javascriptFeatureTraceSchemas.js";
import { analyzeJavaScriptDirectory } from "../../support/cli/javascriptApplication.js";

const analyze = async (cli: TestCli, extra = "") => {
  const root = await createTestTempDirectory("rea-electron-wrapped-paths-");
  await writeFixtureFiles(root, {
    "preload.js": `const e=require("electron");
      const sender=channel=>(...args)=>e.ipcRenderer.send(channel,...args);
      e.contextBridge.exposeInMainWorld("desktop",{copy:sender("test:copy"),cut:sender("test:cut")});`,
    "main.js": `const e=require("electron");
      function register(channel,handler){e.ipcMain.addListener(channel,event=>allowed(event)&&handler(event))}
      register("test:copy",event=>event.sender.copy());
      register("test:cut",event=>event.sender.cut());${extra}`,
  });
  const output = await cli.run({
    arguments: ["analyze-javascript-application", root, "--json"],
  });
  expect(output.exitCode, output.stderr).toBe(0);
  const { normalized_result: result } = z
    .object({
      normalized_result: javascriptApplicationAnalysisResultSchema,
    })
    .parse(output.json);
  return { root, application: output.json, ...result };
};

cliTest(
  "traces a wrapped bridge member through a unique IPC channel using the public CLI",
  async ({ cli }) => {
    const { root, application, graph } = await analyze(cli);
    const byId = new Map(graph.nodes.map((n) => [n.node_id, n]));
    const joins = graph.edges.filter(
      (e) => e.evidence.extractor.operation === "join-electron-wrapper-paths",
    );
    expect(joins).toHaveLength(2);
    for (const edge of joins) {
      expect(edge.evidence).toMatchObject({
        state: "inferred",
        authority: "static-relationship-inference",
      });
      expect(edge.properties.pairing_basis).toBe(
        "unique-exact-literal-channel",
      );
      expect(
        byId.get(edge.source_node_id)?.observations[0]?.properties.channel,
      ).toBe(edge.properties.channel);
      expect(
        byId.get(edge.target_node_id)?.observations[0]?.properties.channel,
      ).toBe(edge.properties.channel);
      expect(edge.properties.conditions).toEqual([
        expect.objectContaining({ expression: "allowed(event)" }),
      ]);
    }
    const start = graph.nodes.find((n) =>
      n.observations.some(
        (o) =>
          o.properties.entry === "desktop.copy" &&
          o.properties.step_kind === "exposure",
      ),
    );
    expect(start).toBeDefined();
    const visited = new Set<string>(),
      pending = start ? [start.node_id] : [];
    while (pending.length) {
      const id = pending.pop();
      if (!id || visited.has(id)) continue;
      visited.add(id);
      for (const edge of graph.edges)
        if (edge.source_node_id === id) pending.push(edge.target_node_id);
    }
    expect(
      [...visited].some((id) =>
        byId
          .get(id)
          ?.observations.some((o) => o.label === "ipc-event.sender.copy"),
      ),
    ).toBe(true);
    expect(
      [...visited].some((id) =>
        byId
          .get(id)
          ?.observations.some((o) => o.label === "ipc-event.sender.cut"),
      ),
    ).toBe(false);
    const input = join(root, "trace-input.json");
    await writeFile(
      input,
      JSON.stringify({
        application,
        seed: { kind: "api", value: "desktop.copy", match: "exact" },
        direction: "outgoing",
      }),
    );
    const traced = await cli.run({
      arguments: ["trace-application-feature", input, "--json"],
    });
    expect(traced.exitCode).toBe(0);
    const { normalized_result: trace } = z
      .object({
        normalized_result: applicationFeatureTraceResultSchema,
      })
      .parse(traced.json);
    expect(trace.seed_matches).toHaveLength(1);
    expect(
      trace.paths.some(
        (path) =>
          path.contains_inference &&
          path.node_ids.length > 8 &&
          byId
            .get(path.end_node_id)
            ?.observations.some((o) => o.label === "ipc-event.sender.copy"),
      ),
    ).toBe(true);
  },
);

cliTest(
  "traces a nested contextBridge member through a unique IPC channel",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-nested-bridge-");
    await writeFixtureFiles(root, {
      "preload.js": `const { contextBridge, ipcRenderer } = require("electron");
        contextBridge.exposeInMainWorld("api", {
          nested: { write: (value) => ipcRenderer.invoke("nested:write", value) }
        });`,
      "main.js": `const { ipcMain, clipboard } = require("electron");
        ipcMain.handle("nested:write", (event, value) => clipboard.writeText(value));`,
    });
    const output = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(output.exitCode, output.stderr).toBe(0);
    const { normalized_result: application } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(output.json);
    const { graph } = application;
    const paths = graph.nodes
      .flatMap((node) => node.observations)
      .filter(
        (observation) =>
          observation.properties.entry === "api.nested.write" &&
          observation.properties.entry_kind === "bridge-member",
      );
    expect(
      paths.some(
        (observation) => observation.properties.step_kind === "exposure",
      ),
    ).toBe(true);
    expect(
      paths.some(
        (observation) => observation.properties.step_kind === "terminal",
      ),
    ).toBe(true);
    const joins = graph.edges.filter(
      (edge) =>
        edge.evidence.extractor.operation === "join-electron-wrapper-paths",
    );
    expect(joins.map((edge) => edge.properties.channel)).toEqual([
      "nested:write",
    ]);

    const traceInput = join(root, "trace-nested-input.json");
    await writeFile(
      traceInput,
      JSON.stringify({
        application: output.json,
        seed: { kind: "api", value: "api.nested.write", match: "exact" },
        direction: "outgoing",
      }),
    );
    const traced = await cli.run({
      arguments: ["trace-application-feature", traceInput, "--json"],
    });
    expect(traced.exitCode).toBe(0);
    const { normalized_result: trace } = z
      .object({ normalized_result: applicationFeatureTraceResultSchema })
      .parse(traced.json);
    expect(trace.seed_matches).toHaveLength(1);
    expect(trace.paths.some((path) => path.contains_inference)).toBe(true);
  },
);

cliTest(
  "preserves exact bridge member segments through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-bridge-segments-");
    await writeFixtureFiles(root, {
      "preload.js": `const { contextBridge, ipcRenderer } = require("electron");
        const write = () => ipcRenderer.send("write");
        contextBridge.exposeInMainWorld("desktop", {
          "nested.write": write,
          nested: { write },
          __proto__: { inherited: write },
          ["__proto__"]: { own: write },
        });`,
      "main.js": `const { ipcMain } = require("electron");
        ipcMain.on("write", (event) => event.sender.copy());`,
    });
    const output = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(output.exitCode).toBe(0);
    const { normalized_result: application } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(output.json);
    const observations = application.graph.nodes.flatMap((node) =>
      node.observations.filter(
        (observation) =>
          observation.properties.entry_kind === "bridge-member" &&
          observation.properties.step_kind === "exposure",
      ),
    );
    const bridge = application.graph.nodes
      .filter((node) => node.kind === "context-bridge-api")
      .flatMap((node) => node.observations)
      .find((observation) => observation.properties.api_key === "desktop");
    expect(bridge?.properties.members).not.toContain("__proto__.inherited");
    expect(bridge?.properties.members).toContain("__proto__.own");
    const paths = observations.map(
      (observation) => observation.properties.entry_path,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        ["desktop", "nested.write"],
        ["desktop", "nested", "write"],
        ["desktop", "__proto__", "own"],
      ]),
    );
    expect(paths).not.toContainEqual(["desktop", "__proto__", "inherited"]);
    const handlerPaths = application.graph.nodes
      .flatMap((node) => node.observations)
      .filter(
        (observation) => observation.properties.entry_kind === "ipc-handler",
      );
    expect(handlerPaths.length).toBeGreaterThan(0);
    expect(
      handlerPaths.every(
        (observation) => !("entry_path" in observation.properties),
      ),
    ).toBe(true);
  },
);

cliTest(
  "retains a nested bridge path when its IPC handler has no external terminal",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-nested-return-");
    await writeFixtureFiles(root, {
      "preload.js": `const { contextBridge, ipcRenderer } = require("electron");
        contextBridge.exposeInMainWorld("api", {
          nested: { write: (value) => ipcRenderer.invoke("nested:write", value) }
        });`,
      "main.js": `const { ipcMain } = require("electron");
        ipcMain.handle("nested:write", (event, value) => value);`,
    });
    const output = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(output.exitCode).toBe(0);
    const { normalized_result: application } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(output.json);
    const { graph } = application;
    expect(
      graph.nodes.some((node) =>
        node.observations.some(
          (observation) =>
            observation.properties.entry === "api.nested.write" &&
            observation.properties.step_kind === "exposure",
        ),
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (edge) =>
          edge.evidence.extractor.operation === "join-electron-wrapper-paths",
      ),
    ).toBe(false);

    const traceInput = join(root, "trace-nested-input.json");
    await writeFile(
      traceInput,
      JSON.stringify({
        application: output.json,
        seed: { kind: "api", value: "api.nested.write", match: "exact" },
        direction: "outgoing",
      }),
    );
    const traced = await cli.run({
      arguments: ["trace-application-feature", traceInput, "--json"],
    });
    expect(traced.exitCode).toBe(0);
    const { normalized_result: trace } = z
      .object({ normalized_result: applicationFeatureTraceResultSchema })
      .parse(traced.json);
    expect(trace.seed_matches).toHaveLength(1);
    expect(trace.graph?.nodes.length).toBeGreaterThan(1);
  },
);

for (const surface of ["CLI", "stdio MCP"] as const) {
  cliTest(
    `preserves handler ambiguity and short-circuit factory paths through ${surface}`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-electron-branch-paths-");
      await writeFixtureFiles(root, {
        "preload.js": `const e=require("electron");
        e.contextBridge.exposeInMainWorld("empty", {});
        function choose(){
          if(flag)return ()=>e.ipcRenderer.send("test:copy");
          else return ()=>e.ipcRenderer.send("test:cut");
          return ()=>e.ipcRenderer.send("test:dead");
        }
        e.contextBridge.exposeInMainWorld("desktop", {
          choose:choose(),
          ambiguous:()=>e.ipcRenderer.send("test:ambiguous"),
          competing:()=>e.ipcRenderer.send("test:competing"),
          conditional:()=>e.ipcRenderer.send("test:conditional"),
          fallback:()=>e.ipcRenderer.send("test:fallback"),
        });`,
        "main.js": `const e=require("electron");
        const copy=event=>event.sender.copy(), cut=event=>event.sender.cut();
        function register(channel,handler){e.ipcMain.on(channel,handler)}
        register("test:copy",copy);register("test:cut",cut);
        register("test:ambiguous",flag?copy:cut);
        register("test:competing",copy);
        register("test:competing",flag?copy:unknownHandler);
        if(flag) register("test:conditional",copy);
        register("test:fallback",event=>{false ?? event.sender.copy()});`,
      });
      const { graph } = await analyzeJavaScriptDirectory(surface, cli, root);
      const empty = graph.nodes
        .filter((node) => node.kind === "context-bridge-api")
        .flatMap((node) => node.observations)
        .find((observation) => observation.properties.api_key === "empty");
      expect(empty).toMatchObject({
        properties: {
          api_status: "object-literal",
          members: [],
          unknown_members: 0,
          resolution_basis: "direct-syntax",
        },
        evidence: { state: "observed" },
      });
      const joins = graph.edges.filter(
        (edge) =>
          edge.evidence.extractor.operation === "join-electron-wrapper-paths",
      );
      expect(joins.map((edge) => edge.properties.channel).sort()).toEqual([
        "test:copy",
        "test:cut",
      ]);
      const steps = graph.nodes
        .flatMap((node) => node.observations)
        .filter(
          (observation) => observation.properties.step_kind === "terminal",
        );
      expect(
        [
          ...new Set(
            steps
              .filter((step) => step.properties.entry === "desktop.choose")
              .map((step) => step.properties.channel),
          ),
        ].sort(),
      ).toEqual(["test:copy", "test:cut"]);
      for (const [channel, expression] of [
        ["test:copy", "flag"],
        ["test:cut", "!(flag)"],
      ])
        expect(
          steps.find(
            (step) =>
              step.properties.entry === "desktop.choose" &&
              step.properties.channel === channel,
          )?.properties.conditions,
        ).toEqual([expect.objectContaining({ expression })]);
      expect(
        steps.some(
          (step) =>
            step.properties.entry_kind === "ipc-handler" &&
            ["test:ambiguous", "test:fallback"].includes(
              String(step.properties.channel),
            ),
        ),
      ).toBe(false);
    },
  );
}

cliTest(
  "does not join a channel with another untraced compatible handler",
  async ({ cli }) => {
    const { graph } = await analyze(
      cli,
      'e.ipcMain.on("test:copy",event=>unresolved(event));',
    );
    const joins = graph.edges.filter(
      (e) => e.evidence.extractor.operation === "join-electron-wrapper-paths",
    );
    expect(joins.map((e) => e.properties.channel)).toEqual(["test:cut"]);
  },
);

cliTest(
  "keeps shallow bridge members when a sibling exceeds the nesting limit",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-deep-bridge-");
    let deepMember = '() => e.ipcRenderer.send("deep:run")';
    for (let index = 0; index < 129; index += 1)
      deepMember = `{ level${index}: ${deepMember} }`;
    await writeFixtureFiles(root, {
      "preload.js": `const e=require("electron");
        e.contextBridge.exposeInMainWorld("desktop", {
          deep: ${deepMember},
          shallow: () => e.ipcRenderer.send("shallow:run")
        });`,
      "main.js": `const e=require("electron");
        e.ipcMain.on("shallow:run", event => event.sender.copy());
        e.ipcMain.on("deep:run", event => event.sender.copy());`,
    });
    const output = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(output.exitCode).toBe(0);
    const { normalized_result: application } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(output.json);
    const { graph } = application;
    const joins = graph.edges.filter(
      (edge) =>
        edge.evidence.extractor.operation === "join-electron-wrapper-paths",
    );
    expect(joins.map((edge) => edge.properties.channel)).toEqual([
      "shallow:run",
    ]);
    expect(
      graph.nodes
        .flatMap((node) => node.observations)
        .some(
          (observation) =>
            observation.properties.entry === "desktop.shallow" &&
            observation.properties.step_kind === "exposure",
        ),
    ).toBe(true);
  },
);

cliTest(
  "preserves empty bridge member segments in nested paths",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-electron-empty-bridge-key-",
    );
    await writeFixtureFiles(root, {
      "preload.js": `const { contextBridge, ipcRenderer } = require("electron");
        contextBridge.exposeInMainWorld("desktop", {
          "": { nested: { call: () => ipcRenderer.send("empty:key") } }
        });`,
      "main.js": `const { ipcMain } = require("electron");
        ipcMain.on("empty:key", event => event.sender.copy());`,
    });
    const output = await cli.run({
      arguments: ["analyze-javascript-application", root, "--json"],
    });
    expect(output.exitCode).toBe(0);
    const { normalized_result: application } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(output.json);
    const observations = application.graph.nodes.flatMap(
      (node) => node.observations,
    );
    expect(
      observations.some(
        (observation) =>
          observation.properties.entry === "desktop..nested.call" &&
          observation.properties.step_kind === "exposure",
      ),
    ).toBe(true);
    expect(
      application.graph.edges
        .filter(
          (edge) =>
            edge.evidence.extractor.operation === "join-electron-wrapper-paths",
        )
        .map((edge) => edge.properties.channel),
    ).toEqual(["empty:key"]);
  },
);
