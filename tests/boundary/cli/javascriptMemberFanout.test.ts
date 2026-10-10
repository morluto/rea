import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

for (const count of [8, 9, 12]) {
  cliTest(
    `preserves mutation facts across ${count} alias branches`,
    async ({ cli }) => {
      const root = await createTestTempDirectory("rea-member-fanout-");
      const declarations = Array.from(
        { length: count },
        (_, index) => `const c${index} = { value: ${index + 1} };`,
      ).join(" ");
      const members = Array.from(
        { length: count },
        (_, index) => `m${index}: c${index}`,
      ).join(", ");
      const branches = Array.from(
        { length: count - 1 },
        (_, index) => `flag === ${index} ? source.m${index}`,
      ).join(" : ");
      const functions: string[] = [];
      const expected: unknown[] = [];
      for (const effect of ["write", "escape"]) {
        for (const selected of ["first", "last", "keep"]) {
          const name = `probe_${effect}_${selected}`;
          const read =
            selected === "keep"
              ? "source.keep.value"
              : `c${selected === "first" ? 0 : count - 1}.value`;
          functions.push(
            `export function ${name}(flag) { ${declarations} const source = { ${members}, keep: { value: 42 } }; const alias = ${branches} : source.m${count - 1}; ${effect === "write" ? "alias.value = 999" : "mutate(alias)"}; return ${read}; }`,
          );
          expected.push(
            expect.objectContaining({
              exported_name: name,
              static_return_shapes: [
                expect.objectContaining({
                  value_status: selected === "keep" ? "literal" : "unknown",
                  fields: [
                    expect.objectContaining({
                      state: selected === "keep" ? "literal" : "unknown",
                      value: selected === "keep" ? 42 : null,
                    }),
                  ],
                }),
              ],
              return_shape_coverage: expect.objectContaining({
                projection_complete: true,
              }),
            }),
          );
        }
      }
      await writeFile(join(root, "app.js"), functions.join("\n"));
      const result = await cli.run({
        arguments: [
          "analyze-javascript-application",
          root,
          "--artifact-format",
          "directory",
          "--json",
        ],
        environment: {
          HOME: root,
          XDG_CONFIG_HOME: root,
          XDG_CACHE_HOME: root,
          NODE_OPTIONS: "--max-old-space-size=768",
        },
      });
      expect(result.exitCode).toBe(0);
      const evidence = toolContract(
        "analyze_javascript_application",
      ).outputSchema.parse(result.json);
      const analysis = javascriptApplicationAnalysisResultSchema.parse(
        evidence.normalized_result,
      );
      const shapes = analysis.graph.nodes
        .flatMap((node) => node.observations)
        .map((observation) => observation.properties)
        .filter(
          (properties) => properties.semantic_role === "export-return-shapes",
        );
      expect(shapes).toHaveLength(expected.length);
      expect(shapes).toEqual(expect.arrayContaining(expected));
    },
  );
}
