import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { reconstructJavaScriptArtifact } from "../../../src/application/javascript/JavaScriptArtifactReconstruction.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseJavaScriptApplicationGraph } from "../../../src/domain/javascript/javascriptApplicationGraph.js";

const PRELOAD = '{ preload: "./preload.js", sandbox: true }';
const EXPLICIT = `webPreferences: ${PRELOAD}`;

describe("Electron option keys in reconstructed application graphs", () => {
  it.each([
    ["computed binding", `[webPreferences]: ${PRELOAD}`],
    ["later spread", `${EXPLICIT}, ...options`],
    ["later computed key", `${EXPLICIT}, [getKey()]: null`],
    ["later accessor", `${EXPLICIT}, get webPreferences() { return null; }`],
    ["later duplicate", `${EXPLICIT}, webPreferences: null`],
  ])(
    "does not associate a BrowserWindow preload from %s",
    async (_, options) => {
      const result = await reconstructSource(`
      const webPreferences = "title";
      new BrowserWindow({ ${options} });
    `);
      const windows = result.graph.nodes.filter(
        ({ kind }) => kind === "browser-window",
      );
      expect(windows).toHaveLength(1);
      const observation = windows[0]?.observations[0];
      expect(observation).toMatchObject({
        properties: {
          options_status: "object-literal",
          web_preferences_status: "dynamic",
          web_preferences: [],
          preload_path: null,
          preload_resolution_context: null,
        },
        evidence: {
          state: "observed",
          confidence: "exact",
          coverage: { status: "partial" },
        },
      });
      expect(result.electron_summary.preload_entrypoints).toBe(0);
      expect(result.electron_summary.explicit_web_preferences).toBe(0);

      // The independent property:preload heuristic can still discover the nested
      // literal. It must not carry a BrowserWindow-specific observation or edge.
      expect(windowPreloadNodes(result)).toEqual([]);
      expect(
        result.graph.edges.filter(
          (edge) =>
            edge.source_node_id === windows[0]?.node_id &&
            edge.relation === "loads",
        ),
      ).toEqual([]);
      expect(result.graph.edges).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: "maps_to",
            evidence: expect.objectContaining({
              location: observation?.evidence.location,
            }),
          }),
        ]),
      );
    },
  );

  it.each([
    ["plain key", EXPLICIT],
    ["quoted key", `"webPreferences": ${PRELOAD}`],
    ["computed literal", `["webPreferences"]: ${PRELOAD}`],
    ["later explicit key", `...options, [getKey()]: null, ${EXPLICIT}`],
    ["last duplicate key", `webPreferences: null, ${EXPLICIT}`],
  ])(
    "retains the BrowserWindow preload association for %s",
    async (_, options) => {
      const result = await reconstructSource(
        `new BrowserWindow({ ${options} });`,
      );
      const preloads = windowPreloadNodes(result);
      expect(preloads).toHaveLength(1);
      expect(result.electron_summary.preload_entrypoints).toBe(1);
      expect(result.electron_summary.explicit_web_preferences).toBe(2);
      expect(result.graph.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relation: "loads",
            target_node_id: preloads[0]?.node_id,
            evidence: expect.objectContaining({
              state: "inferred",
              confidence: "high",
              extractor: expect.objectContaining({
                operation: "associate-browser-window-preload",
              }),
              coverage: expect.objectContaining({ status: "complete" }),
            }),
          }),
          expect.objectContaining({
            relation: "maps_to",
            source_node_id: preloads[0]?.node_id,
            properties: expect.objectContaining({
              resolved_path: "preload.js",
            }),
          }),
        ]),
      );
    },
  );

  it("keeps a computed serviceName unknown in the utility-process observation", async () => {
    const result = await reconstructSource(`
      const serviceName = "env";
      utilityProcess.fork("./worker.js", [], { [serviceName]: "wrong-name" });
    `);
    const utilities = result.graph.nodes.filter(
      ({ kind }) => kind === "electron-utility",
    );
    expect(utilities).toHaveLength(1);
    expect(utilities[0]?.observations[0]).toMatchObject({
      label: "./worker.js",
      properties: { service_name: null, module_path: "./worker.js" },
      evidence: { coverage: { status: "partial" } },
    });
  });

  it.each([
    ["-0", { status: "dynamic", value: null, expression: "-0" }],
    ["-0.0", { status: "dynamic", value: null, expression: "-0.0" }],
    ["-1e999", { status: "dynamic", value: null, expression: "-1e999" }],
    ["-1", { status: "literal", value: -1, expression: null }],
  ] as const)(
    "preserves the JSON representation of BrowserWindow preference %s",
    async (expression, value) => {
      const result = await reconstructSource(
        `new BrowserWindow({ webPreferences: { zoomFactor: ${expression} } });`,
      );
      const graph: unknown = JSON.parse(JSON.stringify(result.graph));
      const transported = parseJavaScriptApplicationGraph(graph);
      const window = transported.nodes.find(
        ({ kind }) => kind === "browser-window",
      );
      expect(window?.observations[0]?.properties.web_preferences).toEqual([
        { name: "zoomFactor", value },
      ]);
    },
  );
});

type Reconstruction = Awaited<ReturnType<typeof reconstructJavaScriptArtifact>>;

const windowPreloadNodes = (result: Reconstruction) =>
  result.graph.nodes.filter(
    (node) =>
      node.kind === "electron-preload" &&
      node.observations.some(
        ({ properties }) =>
          properties.mechanism === "BrowserWindow:webPreferences.preload",
      ),
  );

const reconstructSource = async (source: string): Promise<Reconstruction> => {
  const root = await createTestTempDirectory("rea-electron-option-keys-");
  await Promise.all([
    writeFile(join(root, "package.json"), JSON.stringify({ main: "main.js" })),
    writeFile(join(root, "main.js"), source),
    writeFile(join(root, "preload.js"), "void 0;"),
    writeFile(join(root, "worker.js"), "void 0;"),
  ]);
  return reconstructJavaScriptArtifact({ input_path: root });
};
