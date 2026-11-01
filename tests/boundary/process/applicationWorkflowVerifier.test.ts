import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { writeVersionedJavaScriptApplicationFixtures } from "../../fixtures/javascriptArtifactApplication.js";

const execute = promisify(execFile);

describe("local application workflow verifier", () => {
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporary
        .splice(0)
        .map(async (path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("reports two-version and trace results", async () => {
    const root = await createTestTempDirectory("rea-application-verifier-");
    temporary.push(root);
    const fixtures = await writeVersionedJavaScriptApplicationFixtures(root);
    const { stdout } = await execute(
      process.execPath,
      [
        "scripts/verify/javascript/application-workflows.mjs",
        "--left",
        fixtures.left,
        "--right",
        fixtures.right,
        "--seed-kind",
        "module",
        "--seed-value",
        "stable",
      ],
      { cwd: process.cwd(), maxBuffer: 16 * 1_024 * 1_024 },
    );
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({
      verified: true,
      summary: {
        added: expect.any(Number),
        removed: expect.any(Number),
        changed: expect.any(Number),
        unknown: expect.any(Number),
      },
      matching: {
        exact_module_source_digest: expect.any(Number),
        structural_fingerprint: expect.any(Number),
      },
      coverage: { status: expect.any(String) },
      trace: { summary: { matched_seeds: expect.any(Number) } },
    });
  }, 20_000);

  it("reports an added parser return field", async () => {
    const root = await createTestTempDirectory("rea-shape-verifier-");
    temporary.push(root);
    const left = join(root, "left");
    const right = join(root, "right");
    await Promise.all([mkdir(left), mkdir(right)]);
    await Promise.all([
      copyFile(
        join(process.cwd(), "tests/fixtures/replay/parser.mjs"),
        join(left, "parser.mjs"),
      ),
      copyFile(
        join(process.cwd(), "tests/fixtures/replay/parser-v2.mjs"),
        join(right, "parser.mjs"),
      ),
    ]);
    const { stdout } = await execute(
      process.execPath,
      [
        "scripts/verify/javascript/application-workflows.mjs",
        "--left",
        left,
        "--right",
        right,
        "--left-module-path",
        "parser.mjs",
        "--left-export-name",
        "default",
        "--right-module-path",
        "parser.mjs",
        "--right-export-name",
        "default",
      ],
      { cwd: process.cwd(), maxBuffer: 16 * 1_024 * 1_024 },
    );
    const result = JSON.parse(stdout);
    expect(result.export_shape_comparison).toMatchObject({
      summary: { added: 1, removed: 0, changed: 0, unknown: 0 },
      changes: [
        {
          status: "added",
          path: "/depth",
          right: { availability: "literal", value: 1 },
        },
      ],
    });
  }, 20_000);
});

it.each([false, true])(
  "joins sibling analysis cleanup after a first failure (cleanup fails: %s)",
  async (cleanupFails) => {
    const root = await createTestTempDirectory(
      "rea-application-verifier-cleanup-",
    );
    const left = join(root, "left");
    const right = join(root, "right");
    const marker = join(root, "cleanup-completed");
    const preload = join(root, "instrument.mjs");
    await Promise.all([mkdir(left), mkdir(right)]);
    const fake = `
import { writeFile } from 'node:fs/promises';
export async function analyzeJavaScriptApplicationWithOwnedScope({input_path}) {
  if (input_path === ${JSON.stringify(left)}) throw new Error('authored first failure');
  await new Promise(resolve => setTimeout(resolve, 200));
  await writeFile(${JSON.stringify(marker)}, 'closed');
  if (${JSON.stringify(cleanupFails)}) throw new Error('authored late cleanup failure');
  return {};
}
`;
    await writeFile(
      preload,
      `
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '../../lib/javascript-application-analysis.mjs' && context.parentURL?.endsWith('/scripts/verify/javascript/application-workflows.mjs'))
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(${JSON.stringify(fake)}) };
  return next(specifier, context);
}});
`,
    );
    const result: unknown = await execute(
      process.execPath,
      [
        "--import",
        preload,
        "scripts/verify/javascript/application-workflows.mjs",
        "--left",
        left,
        "--right",
        right,
      ],
      { timeout: 10_000 },
    ).then(
      () => {
        throw new Error("Expected analysis failure");
      },
      (error: unknown) => error,
    );
    expect(await readFile(marker, "utf8")).toBe("closed");
    expect(result).toMatchObject({
      stderr: expect.stringContaining("authored first failure"),
    });
    if (cleanupFails)
      expect(result).toMatchObject({
        stderr: expect.stringContaining("authored late cleanup failure"),
      });
  },
  20_000,
);
