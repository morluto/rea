import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { analyzeJavaScriptApplication } from "../../../support/javascriptApplicationScope.js";

const graphIdentities = async (source: string) => {
  const inputPath = await createTestTempDirectory("rea-js-template-literal-");
  await writeFile(join(inputPath, "app.js"), `${source}\n`);
  await writeFile(join(inputPath, "dep.js"), "module.exports = 1;\n");
  await writeFile(join(inputPath, "worker.js"), "self.onmessage = null;\n");
  const result = await analyzeJavaScriptApplication({
    input_path: inputPath,
    format: "directory",
  });
  if (!result.ok)
    throw new Error(`Expected analysis success: ${result.error.message}`);
  const { graph } = javascriptApplicationAnalysisResultSchema.parse(
    result.value.normalized_result,
  );
  const artifact = graph.nodes.find(({ kind }) => kind === "artifact");
  if (artifact?.identity.strategy !== "content-digest")
    throw new Error("expected the fixture container identity");
  const containerDigest = artifact.identity.sha256;
  const comparableKey = (key: string): string => {
    if (key.startsWith("[")) {
      const tuple: unknown = JSON.parse(key);
      if (Array.isArray(tuple) && tuple[0] === containerDigest)
        return JSON.stringify(tuple.slice(1));
    }
    const prefix = `${containerDigest}:`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  };
  return (
    graph.nodes
      .filter(({ kind }) => kind !== "javascript-asset" && kind !== "artifact")
      // artifact digests differ between spellings; keep the derived keys.
      .map(({ kind, identity }) => ({
        kind,
        strategy: identity.strategy,
        ...(identity.strategy === "artifact-local-key"
          ? {
              namespace: identity.namespace,
              // retain the source path and semantic key while excluding only this fixture's container digest.
              key: comparableKey(identity.key),
            }
          : {}),
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      )
  );
};

// each quoted literal has the same length as its template spelling, so
// source locations and the semantic portion of each identity stay comparable.
it.each([
  "fetch('https://api.example.com/v1/users');",
  "client['get']('/api/items');",
  "navigator['sendBeacon']('/api/events', payload);",
  "localStorage.setItem('token', 1);",
  "new Worker(new URL('./worker.js', import.meta.url));",
  "const dep = require('./dep.js'); dep();",
  "import('./dep.js');",
])(
  "reads a template without substitutions as its exact string: %s",
  async (quoted) => {
    const template = quoted.replaceAll("'", "`");
    const expected = await graphIdentities(quoted);
    expect(
      expected.some(({ kind }) =>
        ["endpoint", "storage", "worker", "javascript-module"].includes(kind),
      ),
    ).toBe(true);
    await expect(graphIdentities(template)).resolves.toEqual(expected);
  },
);
