import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "reports every unresolved Electron path through CLI and MCP without launching",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-invalid-paths-");
    const application = join(root, "main.js");
    await writeFile(application, "module.exports = {};\n");
    const missing = {
      executable_path: join(root, "missing-electron"),
      application_path: join(root, "missing-application"),
      application_root: join(root, "missing-root"),
    };
    const requestPath = join(root, "input.json");
    await writeFile(requestPath, JSON.stringify(missing));
    const response = await cli.run({
      arguments: ["capture-electron-scenario", requestPath, "--format", "json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(response.exitCode).toBe(1);
    const expectedIssues = Object.entries(missing).map(([field, path]) => ({
      path: [field],
      reason: "invalid_value",
      message: expect.stringContaining(path),
    }));
    expect(response.json).toMatchObject({
      code: "invalid_request",
      details: { issues: expectedIssues },
    });
    expect(response.stdout).toContain("ENOENT");

    const { call } = await connectLocalToolsMcp();
    for (const [field, path] of Object.entries(missing)) {
      const result = await call("capture_electron_scenario", {
        executable_path: process.execPath,
        application_path: application,
        application_root: root,
        [field]: path,
      });
      expect(result.isError).toBe(true);
      const content = result.content.find((item) => item.type === "text");
      if (content?.type !== "text") throw new Error("Missing error response");
      expect(JSON.parse(content.text)).toMatchObject({
        error: {
          code: "invalid_request",
          details: {
            issues: [
              {
                path: [field],
                reason: "invalid_value",
                message: expect.stringContaining(path),
              },
            ],
          },
        },
      });
      expect(content.text).toContain("ENOENT");
    }
    const session = await call("binary_session", {});
    expect(session.isError, JSON.stringify(session)).not.toBe(true);
  },
);

cliTest(
  "rejects a file URL path field without resolving an invented local path",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-electron-file-url-");
    const application = join(root, "main.js");
    await writeFile(application, "module.exports = {};\n");
    const response = await cli.run({
      arguments: [
        "capture-electron-scenario",
        JSON.stringify({
          executable_path: "file:///opt/electron",
          application_path: application,
        }),
        "--format",
        "json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(response.exitCode).toBe(1);
    expect(response.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["executable_path"],
            message: expect.stringContaining(
              "must be absolute local filesystem paths",
            ),
          },
        ],
      },
    });
    expect(response.stdout).not.toContain("ENOENT");
    expect(response.stdout).not.toContain("file:/opt/electron");
  },
);
