import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "rejects an empty native-call target before launch while accepting an explicit current directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-native-call-target-");
    const empty = await cli.run({
      arguments: ["observe-native-calls", "", "{}", "--json"],
      cwd: root,
    });

    expect(empty.exitCode, empty.stderr).not.toBe(0);
    expect(empty.json).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ path: "path", code: "too_small" }),
      ]),
    });

    // Invalid observation input reaches domain validation, proving `.` remains
    // an intentional path without starting LLDB or launching a target.
    const explicitCurrentDirectory = await cli.run({
      arguments: ["observe-native-calls", ".", "{}", "--json"],
      cwd: root,
    });
    expect(explicitCurrentDirectory.exitCode).not.toBe(0);
    expect(explicitCurrentDirectory.json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["breakpoints"] }),
        ]),
      },
    });
  },
);
