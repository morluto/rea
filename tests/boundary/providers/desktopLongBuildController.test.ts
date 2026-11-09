import { execFile } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { BuildComputerLongRuns } from "../../../src/desktop/BuildComputerLongRuns.js";
import type { ControlledComputer } from "../../../src/desktop/BuildComputerController.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

const computerWithRea = async () => {
  const home = await createTestTempDirectory("desktop-long-controller-");
  const bin = join(home, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "rea"),
    `#!/usr/bin/env python3
import os, signal, sys, time
signal.signal(signal.SIGINT, lambda *_: sys.exit(130))
if sys.argv[1] == "wait":
    open(sys.argv[2], "w").close()
    time.sleep(30)
print(os.environ.get("AGENTENV_CONTROL_TOKEN", "no token"))
`,
    { mode: 0o755 },
  );
  const timeouts: number[] = [];
  const computer = {
    exec: async (
      argv: readonly string[],
      timeout: number,
      signal?: AbortSignal,
    ) => {
      timeouts.push(timeout);
      const [command = "", ...args] = argv;
      const { stdout, stderr } = await execute(command, args, {
        cwd: home,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          AGENTENV_CONTROL_TOKEN: "test-token",
        },
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        exit_code: 0,
        stdout,
        stderr,
        timed_out: false,
        truncated: false,
      };
    },
    homeFiles: async () => new Map(),
    redacted: (text: string) => text,
  } as ControlledComputer;
  return { computer, home, timeouts };
};

it("runs a long-budget export through bounded controller calls and publishes its result", async () => {
  const { computer, home, timeouts } = await computerWithRea();
  const owner = new BuildComputerLongRuns(computer);
  const result = await owner.run(["done"], {
    work: ".rea-build",
    stdout: ".rea-build/out.json",
    timeoutS: 7080,
    signal: new AbortController().signal,
  });
  expect(result).toMatchObject({ exitCode: 0, stdoutBytes: 9 });
  expect(await readFile(join(home, ".rea-build/out.json"), "utf8")).toBe(
    "no token\n",
  );
  expect(Math.max(...timeouts)).toBeLessThanOrEqual(3600);
  expect(owner.cleanupResources).toEqual([]);
});

it("stops and joins the real supervised command when the caller cancels", async () => {
  const { computer, home } = await computerWithRea();
  const ready = join(home, "ready");
  const controller = new AbortController();
  const owner = new BuildComputerLongRuns(computer);
  const run = owner
    .run(["wait", ready], {
      work: ".rea-build",
      stdout: ".rea-build/out.json",
      timeoutS: 7080,
      signal: controller.signal,
    })
    .catch((error: unknown) => error);
  const until = Date.now() + 5000;
  while (
    Date.now() < until &&
    !(await access(ready).then(
      () => true,
      () => false,
    ))
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  await expect(access(ready)).resolves.toBeUndefined();
  controller.abort(new Error("cancelled"));
  const failure = await run;
  expect(failure).toBeInstanceOf(AnalysisCancelledError);
  expect(owner.cleanupResources).toEqual([]);
});
