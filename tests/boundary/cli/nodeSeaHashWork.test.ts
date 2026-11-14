import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { nodeSeaOverlappingMachO } from "../../fixtures/nodeSeaOverlapping.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "reports excessive SEA duplicate verification through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sea-hash-work-cli-");
    const path = join(root, "carrier");
    const { bytes } = nodeSeaOverlappingMachO();
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-artifact", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "truncated",
      details: { reason: "limit", boundary: "capacity" },
    });
    expect(result.stdout).toContain("duplicate-blob verification");
    expect(result.stdout).toContain("no runtime override");
    expect((await readFile(path)).equals(bytes)).toBe(true);
  },
);
