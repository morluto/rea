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
