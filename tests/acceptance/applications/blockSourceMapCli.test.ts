import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { asarHeaderBytes } from "../../fixtures/asarHeader.js";
import { resolveJavaScriptApplicationMcpCall } from "../../support/cli/javascriptApplication.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "links a block source-map URL containing an asterisk through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-block-map-");
    const url = "app*part.js.map";
    const directive = "/*# sourceMappingURL=" + url;
    const script = Buffer.from(directive + "*/");
    const mapText = Buffer.from(
      JSON.stringify({ version: 3, sources: [], names: [], mappings: "" }),
    );
    const archive = join(root, "app.asar");
    // ASAR logical names can contain '*' even when the host disallows it.
    const header = asarHeaderBytes(
      JSON.stringify({
        files: {
          "app.js": { size: script.length, offset: "0" },
          [url]: { size: mapText.length, offset: String(script.length) },
        },
      }),
    );
    await writeFile(archive, Buffer.concat([header, script, mapText]));
    let document: unknown;
    if (surface === "CLI") {
      const result = await cli.run({
        arguments: ["analyze-javascript-application", archive, "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      document = result.json;
    } else {
      const call = await resolveJavaScriptApplicationMcpCall(cli, undefined);
      const result = await call("analyze_javascript_application", {
        input_path: archive,
        format: "asar",
      });
      expect(result.isError).not.toBe(true);
      document = result.structuredContent;
    }
    const {
      normalized_result: { graph },
    } = z
      .object({
        normalized_result: javascriptApplicationAnalysisResultSchema,
      })
      .parse(document);
    const digest = createHash("sha256").update(url).digest("hex");
    const map = graph.nodes.find(({ observations }) =>
      observations.some(({ properties }) => properties.declared_url === url),
    );
    if (map === undefined)
      throw new Error("Expected the complete declared URL to identify the map");
    expect(map.observations).toContainEqual(
      expect.objectContaining({
        properties: {
          declared_url: url,
          declared_url_sha256: digest,
          resolved_path: url,
          resolution_status: "resolved",
          available: true,
        },
        evidence: expect.objectContaining({
          location: {
            available: true,
            value: {
              kind: "source-range",
              source: "app.js",
              start: { line: 1, column: 0 },
              end: { line: 1, column: directive.length },
            },
          },
        }),
      }),
    );
    expect(graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "maps_to",
        target_node_id: map.node_id,
        properties: {
          declared_url_sha256: digest,
          resolved_path: url,
          resolution_status: "resolved",
        },
      }),
    );
  },
);
