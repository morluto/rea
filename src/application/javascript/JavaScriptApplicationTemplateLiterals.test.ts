import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { javascriptApplicationAnalysisResultSchema } from "../../domain/javascript/javascriptApplicationAnalysis.js";
import { analyzeJavaScriptApplication } from "./JavaScriptApplicationService.js";

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
  return (
    graph.nodes
      .filter(({ kind }) => kind !== "javascript-asset" && kind !== "artifact")
      // Artifact digests differ between spellings; keep the derived keys.
      .map(({ kind, identity }) => ({
        kind,
        strategy: identity.strategy,
        ...(identity.strategy === "artifact-local-key"
          ? {
              namespace: identity.namespace,
              key: identity.key.replace(/^[0-9a-f]{64}:/u, ""),
            }
          : {}),
      }))
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      )
  );
};

// Each quoted literal has the same length as its template spelling, so
// source locations and every derived identity stay comparable.
it.each([
  "fetch('https://api.example.com/v1/users');",
  "new WebSocket('wss://ws.example.com/socket');",
  "const xhr = new XMLHttpRequest(); xhr.open('GET', 'https://xhr.example.com/data');",
  "localStorage.setItem('token', 1);",
  "sessionStorage.getItem('session-id');",
  "indexedDB.open('records');",
  "new Worker('./worker.js');",
  "const dep = require('./dep.js'); dep();",
  "import('./dep.js');",
  "navigator.serviceWorker.register('./worker.js');",
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
