import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

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
