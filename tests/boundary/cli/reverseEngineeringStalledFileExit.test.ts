import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

/**
 * Stalls one path's `stat` in the child. Its interval keeps the event loop
 * alive, as a real system call that a stalled mount holds does.
 */
const STALLED_STAT = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const stat = fs.promises.stat;
fs.promises.stat = (path, ...rest) => {
  if (path !== process.env.REA_TEST_STALLED_PATH) return stat(path, ...rest);
  setInterval(() => {}, 1_000);
  return new Promise(() => {});
};
syncBuiltinESMExports();
`;

it("exits after reporting a timeout while a stalled file step is still held", async () => {
  const directory = await createTestTempDirectory("rea-stalled-exit-");
  const target = join(directory, "fixture.bin");
  const preload = join(directory, "stalled-stat.mjs");
  await writeFile(target, "fixture");
  await writeFile(preload, STALLED_STAT);
  const failure: unknown = await execute(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      "scripts/rea.mjs",
      "inspect-with-objdump",
      target,
      "file_headers",
      "--command-timeout-ms",
      "100",
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, REA_TEST_STALLED_PATH: target },
      timeout: 30_000,
      maxBuffer: 16 * 1_024 * 1_024,
    },
  ).then(
    () => new Error("Expected the command to fail"),
    (cause: unknown) => cause,
  );
  // Without the exit, the held step keeps the child alive until the timeout
  // above kills it.
  expect(failure).toMatchObject({ code: 1, killed: false });
  expect(String((failure as { stdout: unknown }).stdout)).toContain("100 ms");
});
