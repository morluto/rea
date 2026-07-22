import { execFile } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { writeVersionedJavaScriptApplicationFixtures } from "./fixtures/javascriptArtifactApplication.js";

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

  it("reports bounded two-version and trace claims without source text", async () => {
    const root = await createTestTempDirectory("rea-application-verifier-");
    temporary.push(root);
    const fixtures = await writeVersionedJavaScriptApplicationFixtures(root);
    const { stdout } = await execute(
      process.execPath,
      [
        "scripts/verify-local-application-workflows.mjs",
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
    expect(stdout).not.toContain("stableValue");
  }, 20_000);

  it("verifies the source-owned parser depth return-shape addition", async () => {
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
        "scripts/verify-local-application-workflows.mjs",
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
      runtime_validation: {
        recommended_tool: "run_controlled_replay",
        automatically_started: false,
      },
    });
    expect(stdout).not.toContain("value.slice");
  }, 20_000);
});
