import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseExpression } from "@babel/parser";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { javascriptApplicationAnalysisResultSchema } from "../../domain/javascript/javascriptApplicationAnalysis.js";
import { staticPath } from "../../domain/javascript/javascriptStaticAnalysisHelpers.js";
import { analyzeJavaScriptApplication } from "./JavaScriptApplicationService.js";

const urlCases = [
  ["./preload%20name.cjs", "preload name.cjs", "main.mjs"],
  ["./pr%C3%A9load.cjs", "préload.cjs", "main.mjs"],
  ["./preload%3F%23.cjs", "preload?#.cjs", "main.mjs"],
  ["./preload.cjs?cache=1#v2", "preload.cjs", "main.mjs"],
  ["../preload.cjs?cache=1", "preload.cjs", "src/main.mjs"],
  ["./sub/../preload.cjs", "preload.cjs", "main.mjs"],
  ["./preload.cjs", "preload.cjs", "main.mjs"],
] as const;

const unknownExpressions = [
  'fileURLToPath(new URL("./invalid%.cjs", import.meta.url))',
  'fileURLToPath(new URL("./preload%2fname.cjs", import.meta.url))',
  'fileURLToPath(new URL("./preload%5cname.cjs", import.meta.url))',
  'fileURLToPath(new URL("./%2e/preload.cjs", import.meta.url))',
  'fileURLToPath(new URL("https://example.test/preload.cjs", import.meta.url))',
  'fileURLToPath(new URL("//example.test/preload.cjs", import.meta.url))',
  'fileURLToPath(new URL("#fragment", import.meta.url))',
  'fileURLToPath(new URL("?cache=1", import.meta.url))',
  'fileURLToPath(new URL("./preload.cjs", runtimeBase))',
  "fileURLToPath(new URL(runtimePath, import.meta.url))",
  'convertFileURLToPath(new URL("./preload.cjs", import.meta.url))',
];

describe("source-relative file URL paths", () => {
  it.each(urlCases)(
    "resolves %s to the file read by Node",
    async (reference, target, sourcePath) => {
      const root = await createTestTempDirectory("rea-file-url-path-");
      const sourceFile = join(root, sourcePath);
      await mkdir(dirname(sourceFile), { recursive: true });
      await writeFile(join(root, target), 'module.exports = "real preload";\n');
      if (reference.includes("%") && sourcePath === "main.mjs")
        await writeFile(
          join(root, reference),
          'module.exports = "encoded-name decoy";\n',
        );
      const nativePath = fileURLToPath(
        new URL(reference, pathToFileURL(sourceFile)),
      );
      expect(relative(root, nativePath)).toBe(target);
      expect(await readFile(nativePath, "utf8")).toContain("real preload");
      await writeFile(
        sourceFile,
        `import { fileURLToPath } from "node:url";\nnew BrowserWindow({ webPreferences: { preload: fileURLToPath(new URL(${JSON.stringify(reference)}, import.meta.url)) } });\n`,
      );

      const result = await analyzeJavaScriptApplication({
        input_path: root,
        format: "directory",
      });
      if (!result.ok) throw result.error;
      const { graph } = javascriptApplicationAnalysisResultSchema.parse(
        result.value.normalized_result,
      );
      const preloads = graph.nodes.filter(
        ({ kind }) => kind === "electron-preload",
      );
      expect(preloads).toHaveLength(1);
      expect(preloads[0]?.observations).not.toHaveLength(0);
      for (const observation of preloads[0]?.observations ?? [])
        expect(observation.properties).toMatchObject({
          resolved_path: target,
          resolution_status: "resolved",
          resolution_context: "filesystem-expression",
        });
    },
  );

  it.each(unknownExpressions)("leaves unsupported %s unknown", (expression) => {
    expect(
      staticPath(parseExpression(expression, { sourceType: "module" })),
    ).toBeUndefined();
  });

  it("does not URL-decode literal filesystem punctuation", () => {
    const expression = 'path.join(__dirname, "preload%20?#.cjs")';
    expect(
      staticPath(parseExpression(expression, { sourceType: "module" })),
    ).toBe("preload%20?#.cjs");
  });
});
