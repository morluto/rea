import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);

it("enforces workflow platform labels before contacting Cutter", async () => {
  const workflow = parse(
    await readFile(".github/workflows/real-cutter.yml", "utf8"),
  );
  const labels = workflow.jobs["cutter-upstream"].strategy.matrix.include.map(
    (entry: { platform: string }) => entry.platform,
  );
  expect(labels).toEqual(["linux", "macOS", "Windows"]);
  const root = await createTestTempDirectory("rea-cutter-platform-");
  const preload = join(root, "preload.mjs");
  await writeFile(
    preload,
    `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
Object.defineProperty(process, 'platform', { value: process.env.REA_PROBE_PLATFORM });
childProcess.execFile = () => { throw new Error('fixture discovery reached'); };
syncBuiltinESMExports();
`,
  );
  const check = async (selected: string | undefined, actual: string) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      REA_PROBE_PLATFORM: actual,
    };
    if (selected === undefined) delete env.EXPECTED_PLATFORM;
    else env.EXPECTED_PLATFORM = selected;
    const result: unknown = await execute(
      process.execPath,
      ["--import", preload, "scripts/verify-real-cutter.mjs"],
      { env, timeout: 10_000 },
    ).then(
      () => {
        throw new Error("Fixture discovery should stop the verifier");
      },
      (error: unknown) => error,
    );
    if (
      !(result instanceof Error) ||
      !("stderr" in result) ||
      typeof result.stderr !== "string"
    )
      throw new Error("Missing verifier diagnostics");
    return result.stderr;
  };
  for (const [selected, actual] of [
    ["linux", "linux"],
    ["macOS", "darwin"],
    ["Windows", "win32"],
  ] as const)
    expect(await check(selected, actual)).toContain(
      "fixture discovery reached",
    );
  expect(await check("linux", "darwin")).toContain(
    "Cutter runner did not match its declared platform",
  );
  expect(await check("unknown", "linux")).toContain(
    "Unrecognized Cutter runner platform",
  );
  expect(await check(undefined, "linux")).toContain(
    "fixture discovery reached",
  );
  expect(
    (await readdir(root)).filter((name) =>
      name.startsWith("rea-cutter-smoke-"),
    ),
  ).toEqual([]);
});
