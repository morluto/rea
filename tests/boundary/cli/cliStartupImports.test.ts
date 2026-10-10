import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const MARKER = "REA_TEST_RESOLVED ";
// Dependencies that only one command uses; startup must not resolve them.
const DEFERRED_PACKAGES = ["playwright-core", "isomorphic-git"] as const;
// Report each resolved deferred package on stderr without changing resolution.
const RESOLUTION_HOOK = `data:text/javascript,${encodeURIComponent(`
import { registerHooks } from "node:module";
const packages = ${JSON.stringify(DEFERRED_PACKAGES)};
registerHooks({
  resolve(specifier, context, next) {
    const resolved = next(specifier, context);
    const name = packages.find((item) =>
      resolved.url.includes("/node_modules/" + item + "/"),
    );
    if (name !== undefined)
      process.stderr.write(${JSON.stringify(MARKER)} + name + "\\n");
    return resolved;
  },
});
`)}`;

const resolvedPackages = async (
  arguments_: readonly string[],
): Promise<ReadonlySet<string>> => {
  const { stderr } = await execute(
    process.execPath,
    [`--import=${RESOLUTION_HOOK}`, ...arguments_],
    { cwd: process.cwd(), maxBuffer: 16 * 1_024 * 1_024 },
  );
  return new Set(
    stderr
      .split("\n")
      .filter((line) => line.startsWith(MARKER))
      .map((line) => line.slice(MARKER.length)),
  );
};

const evaluate = (source: string): readonly string[] => [
  "--input-type=module",
  "--eval",
  source,
];

describe("CLI startup imports", () => {
  it("detects each deferred package when its command code loads", async () => {
    await expect(
      resolvedPackages(
        evaluate('await import("./dist/composition/browserScenario.js");'),
      ),
    ).resolves.toContain("playwright-core");
    const source = await createTestTempDirectory("rea-startup-imports-");
    await mkdir(join(source, ".git"));
    await expect(
      resolvedPackages(
        evaluate(
          `const { readReferenceSourceVcs } = await import("./dist/application/ReferenceSourceVcsAdapter.js"); await readReferenceSourceVcs(${JSON.stringify(source)});`,
        ),
      ),
    ).resolves.toContain("isomorphic-git");
  });

  it("does not load command-specific packages to register commands", async () => {
    await expect(
      resolvedPackages(["scripts/rea.mjs", "--help"]),
    ).resolves.toEqual(new Set());
  });
});
