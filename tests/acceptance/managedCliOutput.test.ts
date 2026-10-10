import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { buildManagedPeFixture } from "../../src/dotnet/ManagedPe.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "managed CLI preserves evidence, filters, envelopes, and bounded token counts",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-managed-cli-output-");
    const path = join(root, "fixture.dll");
    await writeFile(path, buildManagedPeFixture());
    const argv = ["inspect-managed-members", path, "--json"];
    const result = await cli.run({ arguments: argv });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      operation: "inspect_managed_members",
      provider: { id: "rea-dotnet-static" },
      subject: { local_path: path },
      normalized_result: {
        methods: [expect.objectContaining({ token: expect.any(String) })],
      },
    });
    const filtered = await cli.run({
      arguments: [...argv, "--filter-output", "operation", "--full-output"],
    });
    expect(filtered.exitCode).toBe(0);
    expect(filtered.json).toMatchObject({
      ok: true,
      data: "inspect_managed_members",
      meta: {
        command: "inspect-managed-members",
        duration: expect.stringMatching(/^\d+ms$/u),
      },
    });
    const count = await cli.run({
      arguments: [...argv, "--filter-output", "operation", "--token-count"],
    });
    expect(count.exitCode).toBe(0);
    expect(count.stdout).toMatch(/^\d+\n$/u);
    const omittedCount = await cli.run({
      arguments: [...argv, "--filter-output", "toString", "--token-count"],
    });
    expect(omittedCount.exitCode).toBe(0);
    expect(omittedCount.stdout).toBe("0\n");
    const jsonl = await cli.run({
      arguments: [
        "inspect-managed-members",
        path,
        "--format",
        "jsonl",
        "--filter-output",
        "operation",
      ],
    });
    expect(jsonl.exitCode).toBe(0);
    expect(jsonl.json).toBe("inspect_managed_members");
  },
);
