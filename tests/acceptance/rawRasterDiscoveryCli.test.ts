import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";
cliTest.for([
  [],
  [
    "--widths",
    "32",
    "--heights",
    "16",
    "--formats",
    "gray8",
    "--min-score",
    "0.75",
  ],
])(
  "discovers unheadered raster candidates through the public CLI",
  async (grid, { cli }) => {
    const root = await createTestTempDirectory("rea-raster-cli-");
    const path = join(root, "bytes");
    await writeFile(
      path,
      Buffer.from(
        Array.from(
          { length: 512 },
          (_, i) => (i % 32) * 5 + Math.floor(i / 32) * 3,
        ),
      ),
    );
    const result = await cli.run({
      arguments: ["inspect-raw-raster-candidates", path, ...grid, "--json"],
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const evidence = toolContract(
      "inspect_raw_raster_candidates",
    ).outputSchema.parse(result.json);
    expect(evidence.confidence).toBe("inferred");
    expect(evidence.normalized_result.candidates.length).toBeGreaterThan(0);
  },
);
