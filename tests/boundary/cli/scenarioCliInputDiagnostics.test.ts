import { join } from "node:path";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { describe, expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

describe("scenario CLI schema diagnostics", () => {
  cliTest("reports browser scenario schema paths", async ({ cli }) => {
    const result = await cli.run({
      arguments: ["capture-browser-scenario", "{}", "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "capture_browser_scenario",
        issues: expect.arrayContaining([
          {
            path: ["browser"],
            reason: "missing_argument",
            expected: "object",
          },
          {
            path: ["start_url"],
            reason: "missing_argument",
            expected: "object",
          },
          {
            path: ["actions"],
            reason: "missing_argument",
            expected: "array",
          },
        ]),
      },
    });
  });

  cliTest("reports Electron scenario schema paths", async ({ cli }) => {
    const result = await cli.run({
      arguments: ["capture-electron-scenario", "{}", "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "capture_electron_scenario",
        issues: expect.arrayContaining([
          {
            path: ["executable_path"],
            reason: "missing_argument",
            expected: "string",
          },
          {
            path: ["application_path"],
            reason: "missing_argument",
            expected: "string",
          },
        ]),
      },
    });
  });
});

for (const field of [
  "executable_path",
  "application_path",
  "application_root",
] as const) {
  cliTest(`names the unresolved Electron ${field}`, async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-path-");
    const missing = join(root, "missing");
    const result = await cli.run({
      arguments: [
        "capture-electron-scenario",
        JSON.stringify({
          executable_path: process.execPath,
          application_path: root,
          application_root: root,
          actions: [],
          [field]: missing,
        }),
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: [field],
            reason: "invalid_value",
            message: expect.stringContaining("ENOENT"),
          },
        ],
      },
    });
    expect(JSON.stringify(result.json)).toContain(missing);
  });
}
