import { expect } from "vitest";

import { processTest } from "../../support/process/processFixture.js";

// Both cases run compiled output, so `dist/` must be at least as new as this
// change. A stale build fails the first case for a reason that says nothing
// about the diff, and a build from newer source could satisfy it without
// exercising the guard. `npm run build:cached` refreshes it.
//
// dist/cli.js registers the command catalog and exports `createCli`; it is not
// the CLI entry point. Executing it directly must not exit 0 with no output,
// which is indistinguishable from a successful invocation.
processTest(
  "refuses a direct run of the compiled command registry",
  async ({ processes }) => {
    const direct = await processes.run(process.execPath, [
      "dist/cli.js",
      "--version",
    ]);
    expect(direct.exitCode).toBe(1);
    expect(direct.stdout).toBe("");
    expect(direct.stderr).toContain("dist/cli.js is the command registry");
    expect(direct.stderr).toContain("scripts/rea.mjs");
  },
);

processTest(
  "still serves --version through the dispatcher",
  async ({ processes }) => {
    const dispatched = await processes.run(process.execPath, [
      "scripts/rea.mjs",
      "--version",
    ]);
    expect(dispatched.exitCode).toBe(0);
    expect(dispatched.stdout.trim()).not.toBe("");
  },
);
