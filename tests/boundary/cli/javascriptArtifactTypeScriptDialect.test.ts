import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import {
  typeScriptDialectCases,
  createTypeScriptDialectArtifact,
  expectTypeScriptDialectReference,
  expectValidTypeScriptInput,
} from "../../fixtures/javascriptArtifactTypeScriptDialect.js";
import { cliTest } from "../../support/cli/cliFixture.js";

for (const format of ["directory", "asar"] as const) {
  for (const command of ["analyze-javascript-application", "analyze"]) {
    cliTest(
      `${command} retains TypeScript dialect reference facts for ${format}`,
      async ({ cli }) => {
        for (const fixture of typeScriptDialectCases)
          await expectValidTypeScriptInput(fixture.path, fixture.source);
        const input = await createTypeScriptDialectArtifact(
          format,
          typeScriptDialectCases,
        );
        const output = await cli.run({ arguments: [command, input, "--json"] });
        expect(output.exitCode).toBe(0);
        const result = javascriptApplicationAnalysisResultSchema.parse(
          parseEvidence(output.json).normalized_result,
        );
        expect(result.statistics).toMatchObject({
          parse_failures: 0,
          invalid_utf8_files: 0,
        });
        for (const fixture of typeScriptDialectCases)
          expectTypeScriptDialectReference(result.graph, fixture);
      },
    );
  }
}
