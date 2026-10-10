import { access } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.skipIf(process.platform === "win32")(
  "exits with a capture_path invalid_request for a named pipe before publishing output",
  async ({ cli, processes }) => {
    const root = await createTestTempDirectory("rea-script-selection-cli-");
    const capturePath = join(root, "capture.pipe");
    const outputDirectory = join(root, "export");
    const created = await processes.run("mkfifo", [capturePath], {
      timeoutMs: 5_000,
    });
    expect(created.exitCode).toBe(0);

    const response = await cli.run({
      arguments: ["export-web-scripts", capturePath, outputDirectory, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
      timeoutMs: 5_000,
    });
    expect(response.exitCode).toBe(1);
    expect(response.signal).toBeNull();
    expect(response.json).toMatchObject({
      error: "Script export failed",
      code: "invalid_request",
      details: {
        operation: "export_web_scripts",
        issues: [
          {
            path: ["capture_path"],
            reason: "invalid_value",
            message: expect.stringContaining("regular file"),
          },
        ],
      },
    });
    expect(response.stdout).toContain(capturePath);
    await expect(access(outputDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
