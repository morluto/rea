import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  structuredRasterFixture,
  fgsRecordFixture,
} from "../fixtures/structuredRaster.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { DEFAULT_STRUCTURED_RASTER_GRAMMAR } from "../../src/domain/structuredRasterDiscovery.js";
cliTest.for(["flat", "fgs-records"] as const)(
  "runs configured structured discovery via CLI (%s)",
  async (profile, { cli }) => {
    const root = await createTestTempDirectory("rea-structured-cli-"),
      path = join(root, "bytes"),
      bytes =
        profile === "flat"
          ? structuredRasterFixture()
          : fgsRecordFixture(structuredRasterFixture());
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: [
        "inspect-structured-raster-candidates",
        path,
        "--profile",
        profile,
        "--grammar",
        JSON.stringify(DEFAULT_STRUCTURED_RASTER_GRAMMAR),
        "--resource-offset",
        "2",
        "--max-resources",
        "3",
        "--max-previews",
        "1",
        "--bits-per-pixel",
        "1",
        "--offset-units",
        "1",
        "--json",
      ],
    });
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    const evidence = toolContract(
      "inspect_structured_raster_candidates",
    ).outputSchema.parse(result.json);
    expect(evidence.confidence).toBe("inferred");
    expect(evidence.normalized_result.projection).toMatchObject({
      resourceOffset: 2,
      returnedResources: 3,
      nextResourceOffset: 5,
      previews: 1,
    });
    expect(
      evidence.normalized_result.tables[0]?.resources[0]?.preview?.kind,
    ).toBe("index-only");
  },
);
