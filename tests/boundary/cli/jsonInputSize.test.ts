import { constants } from "node:buffer";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "rejects malformed oversized CLI input and preserves Evidence decoder resource failures",
  async ({ cli, processes }) => {
    const root = await createTestTempDirectory("rea-json-string-limit-");
    const input = join(root, "oversized.json");
    const file = await open(input, "wx");
    try {
      // Sparse zero bytes are valid UTF-8. Decoding exceeds the native string
      // limit before JSON syntax can be inspected; no huge fixture is retained.
      await file.truncate(constants.MAX_STRING_LENGTH + 1);
    } finally {
      await file.close();
    }
    const limits = {
      input_path: input,
      input_bytes: constants.MAX_STRING_LENGTH + 1,
      max_string_utf16_code_units: constants.MAX_STRING_LENGTH,
    };
    // Run readers sequentially in owned child processes, releasing each large
    // read buffer when its process exits instead of retaining it in Vitest.
    const result = await cli.run({
      arguments: ["trace-application-feature", input, "--json"],
    });
    expect(result.json).toMatchObject({
      code: "invalid_request",
      input_path: input,
      input_reason: "invalid-json",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");

    const evidence = await processes.run(process.execPath, [
      "--input-type=module",
      "-e",
      `import { readJsonFile } from "./dist/application/JsonFiles.js";
       import { projectAnalysisError } from "./dist/domain/analysisErrorProjection.js";
       const result = await readJsonFile(process.argv[1]);
       console.log(JSON.stringify(result.ok ? result : projectAnalysisError(result.error)));`,
      input,
    ]);
    expect(JSON.parse(evidence.stdout)).toMatchObject({
      code: "resource_constraint",
      details: {
        operation: "read_evidence_file",
        resource: "file-size",
        reported_limits: limits,
      },
    });
    expect(evidence.stderr).toBe("");
    expect(evidence.exitCode).toBe(0);
  },
);
