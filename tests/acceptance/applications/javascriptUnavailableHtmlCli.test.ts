import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "preserves SVG script references and reports skipped executable bodies",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-svg-html-cli-");
    const inlineUrl = "https://example.test/svg-inline";
    const html = [
      "<!doctype html><svg>",
      `<script src="ignored.js" language="vbscript">fetch("${inlineUrl}");</script>`,
      '<script href="main.js">ignored();</script>',
      '<script xlink:href="main.js">ignored();</script>',
      '<script href="" xlink:href="main.js">ignored();</script>',
      '<script type="application/json">{"x":1}</script>',
      "</svg><template><svg><script>ignored();</script></svg></template>",
    ].join("\n");
    await writeFile(join(root, "index.html"), html);
    await writeFile(
      join(root, "main.js"),
      'fetch("https://example.test/external");',
    );
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        "--source-path",
        "index.html",
        "--source-path",
        "main.js",
        "--format",
        "json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    const observations = result.graph.nodes.flatMap(
      ({ observations }) => observations,
    );
    const scopes = observations.filter(
      ({ properties }) => properties.operation === "parse-html-inline-scripts",
    );
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      properties: {
        path: "index.html",
        inline_script_count: 1,
        inline_scripts: [
          {
            script_type: "classic",
            location: {
              start: { line: 2, column: 45 },
              end: { line: 2, column: 86 },
            },
          },
        ],
      },
      evidence: {
        state: "unavailable",
        confidence: "unknown",
        coverage: { status: "partial" },
      },
    });
    expect(
      result.graph.edges.filter(
        ({ relation, properties }) =>
          relation === "loads" && properties.resolved_path === "main.js",
      ),
    ).toHaveLength(2);
    const endpoints = result.graph.nodes
      .filter(({ kind }) => kind === "endpoint")
      .flatMap(({ observations }) => observations)
      .map(({ properties }) => properties.value);
    expect(endpoints).toContain("https://example.test/external");
    expect(endpoints).not.toContain(inlineUrl);
  },
);

cliTest.for([
  "invalid-html",
  "empty-html",
  "reference-html",
  "invalid-json",
] as const)(
  "retains applicable unavailable HTML reference scope through CLI for %s",
  async (testCase, { cli }) => {
    const root = await createTestTempDirectory("rea-unavailable-html-");
    const reference = '<script src="main.js"></script>';
    const html =
      testCase === "invalid-html"
        ? Buffer.concat([Buffer.from(reference), Buffer.from([0xff])])
        : testCase === "reference-html"
          ? reference
          : "<html></html>";
    await writeFile(
      join(root, "package.json"),
      '{"name":"html-scope","main":"main.js"}',
    );
    await writeFile(join(root, "main.js"), "module.exports = 42;");
    await writeFile(join(root, "index.html"), html);
    await writeFile(
      join(root, "data.json"),
      testCase === "invalid-json" ? Buffer.from([0xff]) : "{}",
    );
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        ...["package.json", "main.js", "index.html", "data.json"].flatMap(
          (path) => ["--source-path", path],
        ),
        "--format",
        "json",
      ],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const result = javascriptApplicationAnalysisResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    const scopes = result.graph.nodes
      .filter(({ kind }) => kind === "unknown")
      .flatMap(({ observations }) => observations);
    const htmlScopes = scopes.filter(
      ({ properties }) =>
        properties.path === "index.html" &&
        properties.operation === "parse-html-script-references",
    );
    expect(htmlScopes).toHaveLength(testCase === "invalid-html" ? 1 : 0);
    if (testCase === "invalid-html") {
      expect(htmlScopes[0]?.evidence).toMatchObject({
        authority: "artifact-bytes",
        state: "unavailable",
      });
      expect(htmlScopes[0]?.properties.limitation).toContain("invalid-utf8");
      expect(result.graph.coverage).toMatchObject({
        status: "partial",
        truncated: false,
      });
    }
    expect(
      scopes.filter(
        ({ properties }) =>
          properties.path === "data.json" &&
          properties.operation === "parse-json-module",
      ),
    ).toHaveLength(testCase === "invalid-json" ? 1 : 0);
    expect(
      result.graph.edges.filter(
        ({ relation, properties }) =>
          relation === "loads" && properties.script_path !== undefined,
      ),
    ).toHaveLength(testCase === "reference-html" ? 1 : 0);
  },
);
