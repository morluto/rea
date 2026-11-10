import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { z } from "zod";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "projects popup override configuration, opener and preload through %s without executing code",
  { timeout: 60_000 },
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-window-open-");
    await Promise.all([
      writeFile(
        join(root, "package.json"),
        JSON.stringify({
          name: "window-open-fixture",
          version: "1.0.0",
          main: "main.cjs",
        }),
      ),
      writeFile(
        join(root, "main.cjs"),
        `throw new Error("must remain inert");
const { BrowserWindow } = require("electron");
const w = new BrowserWindow({webPreferences:{contextIsolation:true}});
w.webContents.setWindowOpenHandler(() => ({action:"allow",overrideBrowserWindowOptions:{webPreferences:{nodeIntegration:false,preload:require("path").resolve(__dirname,"p2.js")}}}));
w.webContents.setWindowOpenHandler(() => ({action:"deny",overrideBrowserWindowOptions:{webPreferences:{preload:"./denied.js"}}}));
`,
      ),
      writeFile(
        join(root, "p2.js"),
        `throw new Error("preload must remain inert");`,
      ),
    ]);
    let document: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: ["analyze-javascript-application", root, "--format", "json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(response.exitCode, response.stderr).toBe(0);
      document = response.json;
    } else {
      const { call } = await connectLocalToolsMcp();
      const response = await call("analyze_javascript_application", {
        input_path: root,
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      document = response.structuredContent;
    }
    const { graph, summary } = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(document).normalized_result;
    expect(summary).toMatchObject({
      browser_windows: 2,
      explicit_web_preferences: 3,
      preload_entrypoints: 1,
    });
    const windows = graph.nodes.filter(({ kind }) => kind === "browser-window");
    expect(windows).toHaveLength(2);
    const popup = windows.find(
      (node) =>
        node.observations[0]?.properties.configuration_source ===
        "setWindowOpenHandler",
    );
    const opener = windows.find((node) => node !== popup);
    expect(popup?.observations[0]).toMatchObject({
      properties: {
        runtime_creation_observed: false,
        preload_path: "p2.js",
        web_preferences_status: "object-literal",
        web_preferences: [
          {
            name: "nodeIntegration",
            value: { status: "literal", value: false, expression: null },
          },
          {
            name: "preload",
            value: { status: "literal", value: "p2.js", expression: null },
          },
        ],
      },
      evidence: {
        state: "observed",
        extractor: { operation: "observe-window-open-override" },
        location: {
          available: true,
          value: {
            kind: "source-range",
            source: "main.cjs",
            start: { line: 4 },
          },
        },
      },
    });
    const parent = graph.edges.filter(
      (edge) =>
        edge.evidence.extractor.operation === "associate-window-open-opener",
    );
    expect(parent).toMatchObject([
      {
        source_node_id: opener?.node_id,
        target_node_id: popup?.node_id,
        relation: "contains",
        properties: {
          relationship: "popup-configuration",
          runtime_creation_observed: false,
        },
        evidence: { state: "inferred" },
      },
    ]);
    expect(
      graph.edges.filter(
        (edge) =>
          edge.source_node_id === popup?.node_id &&
          edge.evidence.extractor.operation ===
            "associate-browser-window-preload",
      ),
    ).toMatchObject([
      {
        relation: "loads",
        properties: {
          declared_path: "p2.js",
          resolved_path: "p2.js",
          resolution_status: "resolved",
        },
      },
    ]);
    expect(
      graph.nodes
        .flatMap((node) => node.observations)
        .some((obs) => obs.properties.preload_path === "./denied.js"),
    ).toBe(false);
  },
);
