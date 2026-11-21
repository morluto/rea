import { expect } from "vitest";

import { processTest } from "../../support/process/processFixture.js";

// Exercise the compiled registry and supported dispatcher; test:focused builds them.
processTest.for([[], ["--version"]] as const)(
  "refuses a direct run of the compiled command registry with %j",
  async (arguments_, { processes }) => {
    const direct = await processes.run(process.execPath, [
      "dist/cli.js",
      ...arguments_,
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
    expect(dispatched.stderr).toBe("");
    expect(dispatched.stdout.trim()).not.toBe("");
  },
);

processTest(
  "imports the registry without serving or replacing the caller exit status",
  async ({ processes }) => {
    const imported = await processes.run(process.execPath, [
      "--input-type=module",
      "--eval",
      'process.exitCode = 23; const registry = await import("./dist/cli.js"); process.stdout.write(typeof registry.createCli);',
    ]);
    expect(imported.exitCode).toBe(23);
    expect(imported.stdout).toBe("function");
    expect(imported.stderr).toBe("");
  },
);
