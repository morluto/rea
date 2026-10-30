import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";
import { z } from "zod";

import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["CLI", "stdio MCP"] as const)(
  "retains wrapped protocol.handle source registrations through %s",
  async (surface, { cli }) => {
    const root = await createTestTempDirectory("rea-electron-handle-presence-");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ main: "main.cjs" }),
    );
    await writeFile(
      join(root, "main.cjs"),
      `
      const { protocol, session } = require("electron");
      protocol.handle("module-omitted");
      protocol.handle("module-null", null);
      protocol.handle("module-undefined", void 0);
      session.defaultSession.protocol.handle("session-omitted");
      session.defaultSession.protocol.handle("session-null", null);
      session.defaultSession.protocol.handle("session-undefined", void 0);
      protocol.registerStringProtocol("legacy-omitted");
      protocol.registerStringProtocol("legacy-null", null);
      protocol.registerStringProtocol("legacy-undefined", void 0);
      throw new Error("analysis fixture must remain inert");
    `,
    );
    let document: unknown;
    if (surface === "CLI") {
      const response = await cli.run({
        arguments: ["analyze-javascript-application", root, "--json"],
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
    const result = z
      .object({ normalized_result: javascriptApplicationAnalysisResultSchema })
      .parse(document).normalized_result;
    expect(result.summary.protocol_registrations).toBe(6);
    const schemes = result.graph.nodes.filter(
      ({ kind }) => kind === "url-scheme",
    );
    expect(
      schemes.map((node) => node.observations[0]?.label).toSorted(),
    ).toEqual([
      "module-null",
      "module-omitted",
      "module-undefined",
      "session-null",
      "session-omitted",
      "session-undefined",
    ]);
    for (const scheme of schemes) {
      const observation = scheme.observations[0];
      expect(observation?.properties).toMatchObject({
        api: "handle",
        role: "handler",
        resolution: "literal",
      });
      expect(observation?.evidence).toMatchObject({
        authority: "ast-static-analysis",
        state: "observed",
        limitations: expect.arrayContaining([
          expect.stringContaining("successful registration"),
        ]),
      });
    }
    expect(
      result.graph.edges.filter((edge) => edge.relation === "handles"),
    ).toHaveLength(6);
  },
);
