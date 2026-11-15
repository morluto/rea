import { join } from "node:path";
import { expect } from "vitest";
import { processTest } from "../../support/process/processFixture.js";
import { copyScriptsWithImports } from "../../support/scriptImportClosure.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

processTest(
  "loads the Android fixture fetcher before build or dependency installation",
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-android-bootstrap-");
    // Copy the actual bootstrap inputs into a checkout without dist or
    // node_modules so an installed dependency cannot hide a new coupling.
    await copyScriptsWithImports(["scripts/fixtures/android/fetch.mjs"], root);
    const entry = join(root, "scripts/fixtures/android/fetch.mjs");
    // Invalid arguments stop before downloads while exercising Node's real
    // source-module loading, without Vitest's .js-to-.ts resolution.
    const result = await processes.run(process.execPath, [
      entry,
      "extra",
      "argument",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "Usage: npm run fixtures:android -- [DIRECTORY]",
    );
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
  },
);
