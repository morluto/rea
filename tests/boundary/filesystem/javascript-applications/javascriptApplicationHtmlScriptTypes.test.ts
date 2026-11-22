import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { analyzeJavaScriptApplication } from "../../../support/javascriptApplicationScope.js";
import { writeFixtureFiles } from "../../../support/javascriptApplicationFixture.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../../src/domain/javascript/javascriptApplicationAnalysis.js";

it("projects only JavaScript renderer loads with their own document provenance", async () => {
  const root = await createTestTempDirectory("rea-html-script-types-");
  const declarations = [
    ["classic.js", 'type=" Text/JavaScript "'],
    ["module.js", 'type="module"'],
    ["data.js", 'type="application/json"'],
    ["imports.js", 'type="importmap"'],
    ["rules.js", 'type="speculationrules"'],
    ["unsupported.js", 'language="vbscript"'],
  ] as const;
  const html = declarations
    .map(
      ([path, attributes]) => `<script ${attributes} src="${path}"></script>`,
    )
    .join("\n");
  await writeFixtureFiles(root, {
    "index.html": html,
    "nested/index.html": '<script type="module" src="../module.js"></script>',
    ...Object.fromEntries(declarations.map(([path]) => [path, "export {};"])),
  });
  const result = await analyzeJavaScriptApplication({
    input_path: root,
    format: "directory",
  });
  if (!result.ok) throw result.error;
  const analysis = javascriptApplicationAnalysisResultSchema.parse(
    result.value.normalized_result,
  );
  const loads = analysis.graph.edges
    .filter(
      ({ relation, properties }) =>
        relation === "loads" && typeof properties.script_path === "string",
    )
    .map(({ properties, evidence: { location } }) => [
      location.available && location.value.kind === "source-range"
        ? location.value.source
        : null,
      properties.script_path,
      properties.resolved_path,
    ]);
  expect(loads).toHaveLength(3);
  expect(loads).toEqual(
    expect.arrayContaining([
      ["index.html", "classic.js", "classic.js"],
      ["index.html", "module.js", "module.js"],
      ["nested/index.html", "../module.js", "module.js"],
    ]),
  );
});
