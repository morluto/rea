import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { parseApplicationGraphEvidence } from "../../../src/application/javascript/JavaScriptApplicationEvidenceGraph.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const analyze = async (root: string) => {
  const result = await analyzeJavaScriptApplication({
    input_path: root,
    format: "directory",
  });
  if (!result.ok) throw result.error;
  const authenticated = parseApplicationGraphEvidence(result.value);
  return {
    graph: authenticated.graph,
    result: javascriptApplicationAnalysisResultSchema.parse(
      authenticated.evidence.normalized_result,
    ),
  };
};

describe("literal CommonJS paths in application graphs", () => {
  it("agrees with Node for both require projections while preserving ESM suffixes", async () => {
    const root = await createTestTempDirectory("rea-literal-require-");
    const specifier = "./dep.cjs#literal.cjs";
    await Promise.all([
      writeFile(
        join(root, "main.cjs"),
        `const value = require(${JSON.stringify(specifier)}); module.exports = value;`,
      ),
      writeFile(
        join(root, "imports.mjs"),
        `import value from ${JSON.stringify(specifier)}; export { value };`,
      ),
      writeFile(join(root, "dep.cjs"), "module.exports = 'stripped';"),
      writeFile(
        join(root, "dep.cjs#literal.cjs"),
        "module.exports = 'literal';",
      ),
    ]);
    const expected = relative(
      root,
      createRequire(join(root, "main.cjs")).resolve(specifier),
    )
      .split(sep)
      .join("/");
    expect(expected).toBe("dep.cjs#literal.cjs");
    const { graph } = await analyze(root);
    const properties = graph.edges
      .filter((edge) => edge.properties.specifier === specifier)
      .map((edge) => edge.properties);
    expect(properties).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          module_link_kind: "require",
          resolved_path: expected,
        }),
        expect.objectContaining({ kind: "require", resolved_path: expected }),
        expect.objectContaining({
          module_link_kind: "import",
          resolved_path: "dep.cjs",
        }),
        expect.objectContaining({
          kind: "static-import",
          resolved_path: "dep.cjs",
        }),
      ]),
    );
    expect(graph.coverage.status).toBe("complete");
  });

  it.each(["literal", "stripped", "both"] as const)(
    "keeps native graph/count projections aligned with %s files",
    async (layout) => {
      const root = await createTestTempDirectory("rea-literal-native-");
      const specifier = "./addon.node#literal.node";
      await Promise.all([
        writeFile(
          join(root, "main.cjs"),
          `const addon = require(${JSON.stringify(specifier)}); module.exports = require(${JSON.stringify(specifier)}); throw new Error('must not execute');`,
        ),
        writeFile(
          join(root, "imports.mjs"),
          `import addon from ${JSON.stringify(specifier)}; export { default } from ${JSON.stringify(specifier)}; throw new Error('must not execute');`,
        ),
        ...(layout !== "stripped"
          ? [
              writeFile(
                join(root, "addon.node#literal.node"),
                Buffer.from([0, 1, 2, 3]),
              ),
            ]
          : []),
        ...(layout !== "literal"
          ? [writeFile(join(root, "addon.node"), Buffer.from([0, 4, 5, 6]))]
          : []),
      ]);
      const { graph, result } = await analyze(root);
      const bindings = graph.nodes
        .filter(({ kind }) => kind === "native-export")
        .flatMap(({ observations }) => observations)
        .map((observation) => ({
          source:
            observation.evidence.location.available &&
            observation.evidence.location.value.kind === "source-range"
              ? observation.evidence.location.value.source
              : null,
          binding: observation.properties.binding_kind,
          path: observation.properties.resolved_path,
        }));
      const required = layout !== "stripped" ? "addon.node#literal.node" : null;
      const imported = layout !== "literal" ? "addon.node" : null;
      expect(bindings).toHaveLength(4);
      expect(bindings).toEqual(
        expect.arrayContaining([
          { source: "main.cjs", binding: "require", path: required },
          { source: "main.cjs", binding: "re-export", path: required },
          { source: "imports.mjs", binding: "import", path: imported },
          { source: "imports.mjs", binding: "re-export", path: imported },
        ]),
      );
      expect(result.summary).toMatchObject({
        native_addon_bindings: 4,
        resolved_native_addon_bindings: layout === "both" ? 4 : 2,
      });
    },
  );
});
