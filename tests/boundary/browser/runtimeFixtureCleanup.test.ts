import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.skipIf(process.platform === "win32")(
  "rejects an exited fixture before returning a lease and removes its profile",
  async () => {
    const root = await createTestTempDirectory("rea-runtime-startup-failure-");
    const helper = new URL(
      "../../../scripts/lib/browser-runtime-fixture-lifecycle.mjs",
      import.meta.url,
    );
    const script = `
      const { startRuntimeFixtureBrowser } = await import(${JSON.stringify(helper.href)});
      // Node rejects Chrome's arguments immediately, exercising actual process exit.
      try {
        const fixture = await startRuntimeFixtureBrowser(process.execPath, 'http://127.0.0.1');
        await fixture.close();
        throw new Error('Expected startup failure');
      } catch (error) {
        if (error._tag !== 'BrowserStartupError') throw error;
        console.log(JSON.stringify({
          failure: error.failure,
          exitCode: error.exitCode,
          stderr: error.stderr,
        }));
      }
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root },
        timeout: 10_000,
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      failure: "exited",
      exitCode: expect.any(Number),
      stderr: expect.stringContaining("bad option"),
    });
    expect(await readdir(root)).toEqual([]);
  },
);

it("attempts every fixture cleanup and retains the primary capture failure", async () => {
  const helper = new URL(
    "../../../scripts/lib/browser-runtime-fixture-lifecycle.mjs",
    import.meta.url,
  );
  const script = `
    const { closeRuntimeFixtureResources } = await import(${JSON.stringify(helper.href)});
    const seen = [];
    try {
      await closeRuntimeFixtureResources([
        async () => { seen.push('first'); throw new Error('first cleanup failed'); },
        async () => { seen.push('second'); throw new Error('second cleanup failed'); },
        async () => { seen.push('third'); },
      ], new Error('capture failed'));
      throw new Error('Expected aggregate cleanup failure');
    } catch (error) {
      if (!(error instanceof AggregateError)) throw error;
      console.log(JSON.stringify({ seen, errors: error.errors.map(item => item.message) }));
    }
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--input-type=module", "-e", script],
    { timeout: 10_000 },
  );
  const result: unknown = JSON.parse(stdout);
  expect(result).toEqual({
    seen: ["first", "second", "third"],
    errors: ["capture failed", "first cleanup failed", "second cleanup failed"],
  });
});
