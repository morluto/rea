import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

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
    const root = await mkdtemp(join(tmpdir(), "rea-application-verifier-"));
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
});
