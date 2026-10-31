import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

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

cliTest(
  "reports an unavailable inline-scripts scope through the CLI while external scripts survive",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-inline-html-cli-");
    const inlineUrl = "https://example.test/inline-only";
    const inlineKey = "inline-only-key";
    const moduleBody = 'import "./main.js";';
    const htmlBytes = Buffer.from(
      [
        "<!doctype html><html><head>",
        '<script src="main.js"></script>',
        "<script>",
        `fetch("${inlineUrl}"); localStorage.setItem("${inlineKey}", "value");`,
        "</script>",
        `<script type="module">${moduleBody}</script>`,
        '<script type="application/json">{"value":42}</script>',
        "</head></html>",
      ].join("\n"),
    );
    await writeFile(
      join(root, "package.json"),
      '{"name":"inline-html-scope","main":"main.js"}',
    );
    await writeFile(
      join(root, "main.js"),
      'fetch("https://example.test/external");',
    );
    await writeFile(join(root, "index.html"), htmlBytes);
    const response = await cli.run({
      arguments: [
        "analyze-javascript-application",
        root,
        ...["package.json", "main.js", "index.html"].flatMap((path) => [
          "--source-path",
          path,
        ]),
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
      .flatMap(({ observations }) => observations)
      .filter(
        ({ properties }) =>
          properties.operation === "parse-html-inline-scripts" &&
          properties.path === "index.html",
      );
    expect(scopes).toHaveLength(1);
    expect(scopes[0]).toMatchObject({
      properties: {
        operation: "parse-html-inline-scripts",
        path: "index.html",
        inline_script_count: 2,
        inline_scripts: [
          {
            script_type: "classic",
            location: {
              start: { line: 3, column: 8 },
              end: { line: 5, column: 0 },
            },
          },
          {
            script_type: "module",
            location: {
              start: { line: 6, column: 22 },
              end: { line: 6, column: 22 + moduleBody.length },
            },
          },
        ],
      },
      evidence: {
        state: "unavailable",
        confidence: "unknown",
        artifact: {
          sha256: createHash("sha256").update(htmlBytes).digest("hex"),
        },
        coverage: { status: "partial" },
      },
    });
    expect(result.graph.coverage).toMatchObject({
      status: "partial",
      truncated: false,
    });
    expect(result.graph.limitations).toContain(
      "index.html has 2 inline JavaScript bodies starting at lines 3, 6 that were not analyzed; endpoints, storage, imports and other facts in them are absent from the evidence.",
    );
    expect(
      result.graph.edges.some(
        ({ relation, properties }) =>
          relation === "loads" &&
          properties.script_path === "main.js" &&
          properties.resolved_path === "main.js",
      ),
    ).toBe(true);
    expect(
      result.graph.nodes
        .filter(({ kind }) => kind === "endpoint")
        .flatMap(({ observations }) => observations)
        .map(({ properties }) => properties.value),
    ).toContain("https://example.test/external");
    expect(
      result.graph.nodes.some(
        ({ kind, observations }) =>
          kind === "endpoint" &&
          observations.some(({ properties }) => properties.value === inlineUrl),
      ),
    ).toBe(false);
    expect(
      result.graph.nodes.some(
        ({ kind, observations }) =>
          kind === "storage" &&
          observations.some(({ properties }) => properties.name === inlineKey),
      ),
    ).toBe(false);
  },
);
