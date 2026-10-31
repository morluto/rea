import { expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["--target=", "--target"] as const)(
  "doctor refuses an explicitly empty target: %s",
  async (spelling, { cli }) => {
    const args =
      spelling === "--target="
        ? ["doctor", "--target=", "--json"]
        : ["doctor", "--target", "", "--json"];
    const result = await cli.run({ arguments: args, timeoutMs: 10_000 });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.stdout).toContain("target");
    expect(result.stdout).not.toContain(
      '"classification":"unsupported_target"',
    );
  },
);

cliTest(
  "doctor advertises the nonempty optional target constraint",
  async ({ cli }) => {
    const result = await cli.run({
      arguments: ["doctor", "--schema", "--json"],
      timeoutMs: 10_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('"minLength": 1');
  },
);
