import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { reconstructJavaScriptArtifact } from "../../../src/application/javascript/JavaScriptArtifactReconstruction.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseJavaScriptApplicationGraph } from "../../../src/domain/javascript/javascriptApplicationGraph.js";
import { analyzeJavaScriptApplicationInputSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { writeElectronBoundaryFixture } from "../../fixtures/electronBoundaryApplication.js";

describe("static Electron application analysis", () => {
  it("accepts relative paths and rejects caller-selected analysis bounds", () => {
    expect(
      analyzeJavaScriptApplicationInputSchema.safeParse({
        input_path: "relative/app.asar",
      }).success,
    ).toBe(true);
    expect(
      analyzeJavaScriptApplicationInputSchema.safeParse({
        input_path: "/tmp/app.asar",
        limits: { max_findings: 200_000 },
      }).success,
    ).toBe(false);
  });

  it("maps windows, preload, contextBridge, IPC, validations, utility, and native boundaries without execution", async () => {
    const root = await fixtureDirectory();
    Reflect.deleteProperty(globalThis, "__rea_electron_fixture_executed");

    const first = await reconstructJavaScriptArtifact({ input_path: root });
    const second = await reconstructJavaScriptArtifact({ input_path: root });
    const graph = parseJavaScriptApplicationGraph(first.graph);

    expect(
      Reflect.get(globalThis, "__rea_electron_fixture_executed"),
    ).toBeUndefined();
    expect(first.graph).toEqual(second.graph);
    expectElectronSummary(first);
    expectElectronRoles(graph);
    expectElectronBoundaries(graph);
  });

  it("analyzes the selected local application directory directly", async () => {
    const root = await fixtureDirectory();

    const result = await analyzeJavaScriptApplication({
      input_path: root,
    });

    if (!result.ok) throw result.error;
    const evidence = parseEvidence(result.value);
    expect(evidence).toMatchObject({
      operation: "analyze_javascript_application",
      predicate_type: "rea.javascript-application-analysis",
      provider: { id: "rea-javascript-application" },
      authority: "shipped-artifact",
      confidence: "derived",
      subject: { local_path: root, format: "directory" },
      normalized_result: {
        input_path: root,
        summary: { browser_windows: 3 },
      },
    });
  });

  it("keeps computed identifier member keys unknown", async () => {
    const root = await computedMemberFixtureDirectory();

    const result = await reconstructJavaScriptArtifact({ input_path: root });
    const graph = parseJavaScriptApplicationGraph(result.graph);
    const requestedMembers = graph.nodes.flatMap((node) =>
      node.kind === "native-export"
        ? node.observations.flatMap(({ properties }) => {
            const members = properties.requested_members;
            return Array.isArray(members) ? members : [];
          })
        : [],
    );

    expect(result.electron_summary).toMatchObject({
      sender_validation_observations: 0,
      native_addon_bindings: 1,
      resolved_native_addon_bindings: 1,
    });
    expect(requestedMembers).toEqual(["*"]);
  });

  it("roots the graph at the application manifest, not a dependency", async () => {
    const root = await dependencyFixtureDirectory();

    const result = await reconstructJavaScriptArtifact({ input_path: root });
    const graph = parseJavaScriptApplicationGraph(result.graph);
    const rootLabels = graph.nodes.flatMap(({ node_id, observations }) =>
      graph.root_node_ids.includes(node_id)
        ? observations.map(({ label }) => label)
        : [],
    );
    const entries = (role: string) =>
      graph.nodes.flatMap(({ kind, observations }) =>
        kind === role
          ? observations.map(({ properties }) => properties.declared_path)
          : [],
      );

    expect(rootLabels).toEqual(["app"]);
    expect(entries("electron-main")).toEqual(["main.js"]);
    expect(entries("electron-renderer")).toEqual([]);
  });

  it("maps Electron boundaries through bundler-renamed bindings", async () => {
    const root = await renamedBindingFixtureDirectory();

    const result = await reconstructJavaScriptArtifact({ input_path: root });
    const graph = parseJavaScriptApplicationGraph(result.graph);
    const handledChannels = graph.nodes.flatMap(({ kind, observations }) =>
      kind === "ipc-handler"
        ? observations.flatMap(({ properties }) =>
            properties.side === "main" ? [properties.channel] : [],
          )
        : [],
    );

    expect(result.electron_summary).toMatchObject({
      browser_windows: 1,
      context_bridge_apis: 1,
      exposed_api_members: 2,
      ipc: {
        main_handlers: 2,
        paired_renderer_transmissions: 2,
        unpaired_literal_renderer_transmissions: 0,
      },
      utility_processes: 1,
    });
    expect(handledChannels.sort()).toEqual(["rea:read", "rea:write"]);
  });

  it("maps unchanged var and let require aliases while excluding reassigned bindings", async () => {
    const root = await requireAliasFixtureDirectory();

    const result = await reconstructJavaScriptArtifact({ input_path: root });

    expect(result.electron_summary.ipc).toMatchObject({
      main_handlers: 2,
      paired_renderer_transmissions: 2,
      unpaired_literal_renderer_transmissions: 0,
    });
  });

  it("returns a tagged cancellation without executing application code", async () => {
    const root = await fixtureDirectory();
    const controller = new AbortController();
    controller.abort();
    Reflect.deleteProperty(globalThis, "__rea_electron_fixture_executed");

    const result = await analyzeJavaScriptApplication(
      { input_path: root },
      { signal: controller.signal },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "ArtifactOperationError", reason: "cancelled" },
    });
    expect(
      Reflect.get(globalThis, "__rea_electron_fixture_executed"),
    ).toBeUndefined();
  });
});

type Reconstruction = Awaited<ReturnType<typeof reconstructJavaScriptArtifact>>;
type ApplicationGraph = ReturnType<typeof parseJavaScriptApplicationGraph>;

const expectElectronSummary = (result: Reconstruction): void => {
  expect(result.electron_summary).toMatchObject({
    browser_windows: 3,
    explicit_web_preferences: 8,
    preload_entrypoints: 1,
    context_bridge_apis: 2,
    exposed_api_members: 5,
    ipc: {
      literal_channels: 5,
      dynamic_channel_operations: 2,
      paired_renderer_transmissions: 4,
      ambiguous_renderer_transmissions: 1,
      unpaired_literal_renderer_transmissions: 1,
    },
    sender_validation_observations: 2,
    utility_processes: 1,
    resolved_utility_entrypoints: 1,
    native_addon_bindings: 4,
    resolved_native_addon_bindings: 4,
  });
};

const expectElectronRoles = (graph: ApplicationGraph): void => {
  expect(graph.nodes.map(({ kind }) => kind)).toEqual(
    expect.arrayContaining([
      "browser-window",
      "electron-preload",
      "context-bridge-api",
      "ipc-channel",
      "ipc-handler",
      "electron-utility",
      "native-addon",
      "native-export",
    ]),
  );
  const roles = graph.nodes.filter(({ kind }) =>
    ["electron-main", "electron-preload", "electron-renderer"].includes(kind),
  );
  expect(roles.length).toBeGreaterThanOrEqual(3);
  for (const role of roles) {
    for (const observation of role.observations)
      expect(observation.properties).toMatchObject({
        declared_path: expect.any(String),
        resolution_context: expect.stringMatching(
          /^(package-entrypoint|filesystem-expression|module-specifier|html-reference)$/u,
        ),
        resolution_status: expect.stringMatching(
          /^(resolved|not-found|unavailable|external|rejected)$/u,
        ),
        limitations: expect.any(Array),
      });
    if (
      role.observations.some(
        ({ properties }) => properties.resolution_status === "resolved",
      )
    )
      expect(
        graph.edges.some(
          (edge) =>
            edge.source_node_id === role.node_id && edge.relation === "maps_to",
        ),
      ).toBe(true);
  }
  const dirnamePreload = roles.find(
    ({ kind, observations }) =>
      kind === "electron-preload" &&
      observations.some(
        ({ properties }) =>
          properties.declared_path === "preload.js" &&
          properties.resolution_context === "filesystem-expression",
      ),
  );
  expect(dirnamePreload?.observations[0]?.properties).toMatchObject({
    declared_path: "preload.js",
    resolution_context: "filesystem-expression",
    resolved_path: "preload.js",
    resolution_status: "resolved",
    limitations: [],
  });
};

const expectElectronBoundaries = (graph: ApplicationGraph): void => {
  expect(graph.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "browser-window",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              preload_path: "preload.js",
              absence_means_default: false,
              web_preferences: expect.arrayContaining([
                expect.objectContaining({
                  name: "nodeIntegration",
                  value: expect.objectContaining({
                    status: "literal",
                    value: true,
                  }),
                }),
              ]),
            }),
          }),
        ]),
      }),
      expect.objectContaining({
        kind: "browser-window",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              web_preferences: expect.arrayContaining([
                expect.objectContaining({
                  name: "nodeIntegration",
                  value: expect.objectContaining({
                    status: "literal",
                    value: false,
                  }),
                }),
                expect.objectContaining({
                  name: "contextIsolation",
                  value: expect.objectContaining({
                    status: "literal",
                    value: true,
                  }),
                }),
              ]),
            }),
          }),
        ]),
      }),
      expect.objectContaining({
        kind: "context-bridge-api",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              api_key: "reaApi",
              members: expect.arrayContaining([
                "nested",
                "nested.write",
                "read",
              ]),
            }),
          }),
        ]),
      }),
      expect.objectContaining({
        kind: "ipc-handler",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              fact_kind: "sender-validation-candidate",
              enforcement: "unknown",
            }),
          }),
        ]),
      }),
      expect.objectContaining({
        kind: "native-export",
        observations: expect.arrayContaining([
          expect.objectContaining({
            properties: expect.objectContaining({
              native_export_verification: "not-performed",
            }),
          }),
        ]),
      }),
    ]),
  );
  const pairingEdges = graph.edges.filter(
    ({ properties }) =>
      properties.pairing_basis === "unique-exact-literal-channel",
  );
  expect(pairingEdges).toHaveLength(4);
  expect(
    pairingEdges.some(
      ({ properties }) => properties.channel === "rea:ambiguous",
    ),
  ).toBe(false);
  expect(graph.limitations.join(" ")).toMatch(/dynamic IPC|ambiguous/iu);
};

const fixtureDirectory = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-electron-boundaries-");
  await writeElectronBoundaryFixture(root);
  return root;
};

const dependencyFixtureDirectory = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-electron-dependency-");
  const dependency = join(root, "node_modules", "dep");
  await mkdir(dependency, { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "app", main: "main.js" }),
    ),
    writeFile(join(root, "main.js"), "module.exports = {};"),
    writeFile(
      join(dependency, "package.json"),
      JSON.stringify({ name: "dep", main: "index.js", browser: "browser.js" }),
    ),
    writeFile(join(dependency, "index.js"), "module.exports = {};"),
  ]);
  return root;
};

const requireAliasFixtureDirectory = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-electron-require-aliases-");
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "rea-electron-require-aliases",
        main: "main.cjs",
      }),
    ),
    writeFile(
      join(root, "main.cjs"),
      String.raw`
var { ipcMain: main } = require("electron");
let listener = require("electron/main").ipcMain;
main.handle("rea:read", async () => "value");
listener.on("rea:write", () => undefined);

let replaced = require("electron").ipcMain;
replaced = { handle() {} };
replaced.handle("rea:reassigned", () => undefined);

var assignedLater;
assignedLater.handle("rea:before-assignment", () => undefined);
assignedLater = require("electron").ipcMain;

if (globalThis.registerIpc) {
  var conditional = require("electron").ipcMain;
}
conditional.handle("rea:conditional", () => undefined);
`,
    ),
    writeFile(
      join(root, "preload.cjs"),
      String.raw`
const { ipcRenderer } = require("electron");
ipcRenderer.invoke("rea:read");
ipcRenderer.send("rea:write", "value");
`,
    ),
  ]);
  return root;
};

const renamedBindingFixtureDirectory = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-electron-renamed-");
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "rea-electron-renamed", main: "main.mjs" }),
    ),
    // Bundlers rename colliding imports, e.g. esbuild's ipcMain2.
    writeFile(
      join(root, "main.mjs"),
      String.raw`
import { BrowserWindow as BrowserWindow2, ipcMain as ipcMain2 } from "electron";
import { ipcMain as ipcMain3, utilityProcess as utility } from "electron/main";

new BrowserWindow2({ webPreferences: { preload: "./preload.cjs" } });
ipcMain2.handle("rea:read", async () => "value");
ipcMain3.on("rea:write", () => undefined);
utility.fork("./worker.js");
function register(ipcMain2) {
  ipcMain2.handle("rea:shadowed", async () => "local");
}
export { register };
`,
    ),
    writeFile(
      join(root, "preload.cjs"),
      String.raw`
const { contextBridge: bridge, ipcRenderer: ipc } = require("electron");
bridge.exposeInMainWorld("reaApi", {
  read: () => ipc.invoke("rea:read"),
  write: (value) => ipc.send("rea:write", value),
});
`,
    ),
    writeFile(join(root, "worker.js"), "module.exports = {};"),
  ]);
  return root;
};

const computedMemberFixtureDirectory = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-electron-computed-members-");
  await mkdir(join(root, "native"));
  await Promise.all([
    writeFile(
      join(root, "main.js"),
      String.raw`
const member = "read";
const selected = require("./native/addon.node")[member];
const startsWith = "includes";
function validate(event) {
  return event.senderFrame.url[startsWith]("file://");
}
module.exports = { selected, validate };
`,
    ),
    writeFile(join(root, "native", "addon.node"), Buffer.from([0, 1, 2, 3])),
  ]);
  return root;
};
