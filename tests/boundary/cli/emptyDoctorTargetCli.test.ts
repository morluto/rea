import { expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

// An empty --target names no app. Like every other target-taking command,
// doctor refuses it before readiness checks instead of checking the
// working directory.
cliTest(
  "refuses an empty doctor --target before any readiness check",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: ["doctor", "--target", "", "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "VALIDATION_ERROR",
      fieldErrors: expect.arrayContaining([
        expect.objectContaining({ path: "target" }),
      ]),
    });
    expect(result.stdout).not.toContain("target_readiness");
  },
);
