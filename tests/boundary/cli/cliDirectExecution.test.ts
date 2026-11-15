import { expect, it } from "vitest";

import {
  execFileOutput,
  execFileOutputFailure,
} from "../../../src/process/ExecFileOutput.js";

const run = (arguments_: readonly string[]) =>
  execFileOutput(process.execPath, arguments_, {
    timeout: 20_000,
    stopSignal: "SIGTERM",
    maxBuffer: 1024 * 1024,
  }).then(
    (output) => ({ exitCode: 0, stdout: output.stdout, stderr: "" }),
    (cause: unknown) => {
      const failure = execFileOutputFailure(cause);
      if (failure === undefined) throw cause;
      return {
        exitCode: failure.code,
        stdout: failure.stdout,
        stderr: failure.stderr,
      };
    },
  );

// dist/cli.js registers the command catalog and exports `createCli`; it is not
// the CLI entry point. Executing it directly must not exit 0 with no output,
// which is indistinguishable from a successful invocation.
it("refuses a direct run of the compiled command registry", async () => {
  const direct = await run(["dist/cli.js", "--version"]);
  expect(direct.exitCode).toBe(1);
  expect(direct.stdout).toBe("");
  expect(direct.stderr).toContain("dist/cli.js is the command registry");
  expect(direct.stderr).toContain("scripts/rea.mjs");
});

it("still serves --version through the dispatcher", async () => {
  const dispatched = await run(["scripts/rea.mjs", "--version"]);
  expect(dispatched.exitCode).toBe(0);
  expect(dispatched.stdout.trim()).not.toBe("");
});
