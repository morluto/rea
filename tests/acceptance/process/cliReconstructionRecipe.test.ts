import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { reconstructionVerificationResultSchema } from "../../../src/domain/reconstructionVerificationSchemas.js";
import {
  CAPTURE_CAPABILITY,
  itWithCaptureCapability as captureTest,
} from "../../boundary/process/processCaptureCapability.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const example = fileURLToPath(
  new URL("../../../scripts/examples/cli-reconstruction.mjs", import.meta.url),
);
const builder = fileURLToPath(
  new URL(
    "../../../scripts/examples/fixtures/cli-sum-builder.mjs",
    import.meta.url,
  ),
);
const original = fileURLToPath(
  new URL(
    "../../../scripts/examples/fixtures/cli-sum-original.mjs",
    import.meta.url,
  ),
);
const load = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8"));

async function observeFixture(args: string[]) {
  try {
    const { stdout } = await execute(process.execPath, [original, ...args]);
    return { stdout, code: 0 };
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "number" &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return { stdout: cause.stdout, code: cause.code };
    throw cause;
  }
}

async function fixtureBrief() {
  const facts = [];
  for (const [id, args] of [
    ["valid", ["sum", "2", "5"]],
    ["invalid", ["sum", "2", "nope"]],
  ] as const) {
    const observed = await observeFixture([...args]);
    facts.push({
      id,
      arguments: [...args],
      observed_pty_output: observed.stdout,
      observed_exit: { code: observed.code, reason: "exited" },
    });
  }
  // These are ordinary subprocess observations for a builder test, not REA
  // capture Evidence or a claim about the PTY provider.
  return { facts };
}

it("the independent example builder changes actual CLI behavior after the identified correction", async () => {
  const directory = await createTestTempDirectory("rea-cli-recipe-builder-");
  const briefPath = join(directory, "brief.json");
  await writeFile(briefPath, JSON.stringify(await fixtureBrief()));
  const actual: string[] = [];
  for (const revision of ["initial", "corrected"] as const) {
    const path = join(directory, `${revision}.mjs`);
    await execute(process.execPath, [builder, path, revision, briefPath]);
    actual.push(
      (await execute(process.execPath, [path, "sum", "2", "5"])).stdout,
    );
    await expect(
      execute(process.execPath, [path, "sum", "2", "nope"]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: "invalid\n",
    });
  }
  expect(actual).toEqual(["8\n", "7\n"]);
  expect(
    (await execute(process.execPath, [original, "sum", "2", "5"])).stdout,
  ).toBe(actual[1]);
  // These subprocess observations exercise the fixture implementer, not REA's
  // native PTY provider. The separately gated recipe test owns that coverage.
});

it("derives candidate outputs, offset and exit codes from the supplied observed brief", async () => {
  const directory = await createTestTempDirectory("rea-cli-recipe-brief-");
  const brief = await fixtureBrief();
  brief.facts[0]!.observed_pty_output = "12\n";
  brief.facts[0]!.observed_exit.code = 4;
  brief.facts[1]!.observed_pty_output = "bad\n";
  brief.facts[1]!.observed_exit.code = 3;
  const briefPath = join(directory, "brief.json");
  await writeFile(briefPath, JSON.stringify(brief));
  const candidate = join(directory, "candidate.mjs");
  await execute(process.execPath, [builder, candidate, "corrected", briefPath]);
  await expect(
    execute(process.execPath, [candidate, "sum", "2", "5"]),
  ).rejects.toMatchObject({ code: 4, stdout: "12\n" });
  await expect(
    execute(process.execPath, [candidate, "sum", "2", "nope"]),
  ).rejects.toMatchObject({ code: 3, stdout: "bad\n" });
});

it.skipIf(CAPTURE_CAPABILITY.available)(
  "rejects an unavailable capture host before creating the investigation",
  async () => {
    const directory = await createTestTempDirectory(
      "rea-cli-recipe-unavailable-",
    );
    const output = join(directory, "investigation");
    await expect(
      execute(process.execPath, [example, output], { windowsHide: true }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        CAPTURE_CAPABILITY.available
          ? "unavailable"
          : CAPTURE_CAPABILITY.reason,
      ),
    });
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

captureTest(
  "researches shipped CLI inputs, builds independently, localizes a failure and verifies the correction through CLI and retained MCP Evidence",
  async () => {
    const directory = await createTestTempDirectory("rea-cli-recipe-real-");
    const output = join(directory, "investigation");
    await execute(process.execPath, [example, output], {
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    for (const revision of ["initial", "corrected"] as const) {
      const cli = reconstructionVerificationResultSchema.parse(
        await load(join(output, `${revision}-cli-verification.json`)),
      );
      const mcp = parseEvidence(
        await load(join(output, `${revision}-mcp-verification.json`)),
      );
      expect(mcp.normalized_result).toEqual(cli);
      expect(cli.status).toBe(revision === "initial" ? "fail" : "unknown");
      expect(cli.summary).toMatchObject({
        total: 5,
        passed: revision === "initial" ? 3 : 4,
        failed: revision === "initial" ? 1 : 0,
        unknown: 1,
      });
      expect(
        cli.claims.items.find(({ claim_id }) => claim_id === "valid-filesystem")
          ?.status,
      ).toBe("unknown");
      const bundle = parseEvidenceBundle(
        await load(join(output, `${revision}-bundle.json`)),
      );
      const ids = new Set(bundle.records.map(({ evidence_id }) => evidence_id));
      expect(cli.evidence_links.every((id) => ids.has(id))).toBe(true);
      const comparison = parseEvidence(
        await load(join(output, `${revision}-valid-comparison.json`)),
      );
      expect(comparison.normalized_result).toMatchObject({
        terminal: revision === "initial" ? "changed" : "unchanged",
        filesystem: "unknown",
        ...(revision === "initial"
          ? { first_divergence: { status: "found", dimension: "terminal" } }
          : {}),
      });
      const exitComparison = parseEvidence(
        await load(join(output, `${revision}-valid-exit-comparison.json`)),
      );
      expect(exitComparison.normalized_result).toMatchObject({
        exit: "unchanged",
      });
    }
    const brief = JSON.stringify(
      await load(join(output, "reconstruction-brief.json")),
    );
    expect(brief).toContain("static_evidence_id");
    expect(brief).toContain("No filesystem paths selected");
    expect(await readFile(join(output, "recipe-prompt.md"), "utf8")).toContain(
      "Build independently",
    );
    expect(await load(join(output, "correction.json"))).toMatchObject({
      failed_claims: [{ claim_id: "valid-terminal" }],
      first_divergence: { status: "found", dimension: "terminal" },
      change: { from_accumulator_offset: 1, to_accumulator_offset: 0 },
    });
    // Reusing an output directory fails rather than overwriting retained Evidence.
    await expect(
      execute(process.execPath, [example, output]),
    ).rejects.toMatchObject({ code: 1 });
  },
  120_000,
);
