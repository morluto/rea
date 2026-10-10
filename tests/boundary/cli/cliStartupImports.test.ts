import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const MARKER = "REA_TEST_RESOLVED ";
// Report each resolved Playwright module on stderr without changing resolution.
const RESOLUTION_HOOK = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    if (resolved.url.includes("/playwright-core/"))
      process.stderr.write(${JSON.stringify(MARKER)} + resolved.url + "\\n");
    return resolved;
  },
});
`)}`;

const resolvedPlaywright = async (
  arguments_: readonly string[],
): Promise<readonly string[]> => {
  const { stderr } = await execute(
    process.execPath,
    [`--import=${RESOLUTION_HOOK}`, ...arguments_],
    { cwd: process.cwd(), maxBuffer: 16 * 1_024 * 1_024 },
  );
  return stderr.split("\n").filter((line) => line.startsWith(MARKER));
};

describe("CLI startup imports", () => {
  it("detects Playwright when the browser scenario composition loads", async () => {
    await expect(
      resolvedPlaywright([
        "--input-type=module",
        "--eval",
        'await import("./dist/composition/browserScenario.js");',
      ]),
    ).resolves.not.toHaveLength(0);
  });

  it("does not load Playwright to register commands", async () => {
    await expect(
      resolvedPlaywright(["scripts/rea.mjs", "--help"]),
    ).resolves.toEqual([]);
  });
});
