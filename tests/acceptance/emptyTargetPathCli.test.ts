import { expect } from "vitest";

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest.for(["analyze", "inspect-artifact"])(
  "%s rejects an explicitly empty target before resolving it against cwd",
  async (command, { cli }) => {
    const cwd = await createTestTempDirectory("rea-empty-target-");
    const result = await cli.run({
      arguments: [command, "", "--json"],
      cwd,
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({ code: "VALIDATION_ERROR" });
    expect(result.stdout).toContain("path");
    expect(result.stdout).not.toContain("directory_requires_file");
  },
);

cliTest(
  "inspect-artifact still admits an explicitly selected current directory",
  async ({ cli }) => {
    const cwd = await createTestTempDirectory("rea-explicit-target-");
    const result = await cli.run({
      arguments: ["inspect-artifact", ".", "--json"],
      cwd,
    });
    // "." selects the working directory, which is inventoried as a tree.
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.json).toMatchObject({
      subject: {
        identity: {
          kind: "directory",
          algorithm: "rea-directory-tree",
          version: 1,
          // The empty tree's root digest.
          sha256:
            "b28a57a57239d69019456fc9079821c5f31911fc656d15ff77703cb13991b3b6",
        },
        // The caller path owner keeps "."'s directory requirement as a "/".
        local_path: `${cwd}/`,
      },
      caller_input_path: ".",
    });
  },
);
