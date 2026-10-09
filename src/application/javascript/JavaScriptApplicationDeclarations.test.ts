import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { javascriptApplicationAnalysisResultSchema } from "../../domain/javascript/javascriptApplicationAnalysis.js";
import { parseJavaScriptSource } from "../../domain/javascript/javascriptSourceParser.js";
import { analyzeJavaScriptApplication } from "./JavaScriptApplicationService.js";

it.each(["types.d.ts", "types.d.mts", "types.d.cts"])(
  "keeps valid ambient declarations complete in %s",
  async (path) => {
    const root = await createTestTempDirectory("rea-declaration-file-");
    const source = "export const value: number;\n";
    await writeFile(join(root, path), source);
    const result = await analyzeJavaScriptApplication({
      input_path: root,
      format: "directory",
    });
    if (!result.ok) throw result.error;
    const analysis = javascriptApplicationAnalysisResultSchema.parse(
      result.value.normalized_result,
    );
    expect(analysis.graph.coverage.status).toBe("complete");
    expect(parseJavaScriptSource(source, path)?.errors).toEqual([]);
  },
);

it("retains the missing-initializer diagnostic for ordinary TypeScript", () => {
  const errors = parseJavaScriptSource(
    "export const value: number;",
    "types.ts",
  )?.errors;
  expect(errors?.map(({ message }) => message)).toContain(
    "Missing initializer in const declaration. (1:26)",
  );
});

it("keeps CommonJS TypeScript angle-bracket assertions complete", async () => {
  const root = await createTestTempDirectory("rea-cts-assertion-");
  const source = "export const value = <number>42;\n";
  await writeFile(join(root, "app.cts"), source);
  const result = await analyzeJavaScriptApplication({
    input_path: root,
    format: "directory",
  });
  if (!result.ok) throw result.error;
  const analysis = javascriptApplicationAnalysisResultSchema.parse(
    result.value.normalized_result,
  );
  expect(analysis.graph.coverage.status).toBe("complete");
  expect(parseJavaScriptSource(source, "app.cts")?.errors).toEqual([]);
});
