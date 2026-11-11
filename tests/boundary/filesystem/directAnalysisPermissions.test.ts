import { projectCliAnalysisResult } from "../../../src/cli/projectCliAnalysisResult.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createDirectAnalysis } from "../../../src/composition/directAnalysis.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("direct analysis snapshot files", () => {
  it("forwards the CLI provider selector ahead of the environment preference", async () => {
    const directory = await createTestTempDirectory("rea-direct-provider-");
    const targetPath = join(directory, "fixture.hop");
    await writeFile(targetPath, "fixture");
    vi.stubEnv("HOPPER_LAUNCHER_PATH", process.execPath);
    vi.stubEnv("REA_ANALYSIS_PROVIDER", "environment-provider");

    await expect(
      createDirectAnalysis(process.env)
        .runDirectAnalysis(
          targetPath,
          "binary_overview",
          {},
          {
            providerId: "request-provider",
          },
        )
        .then(projectCliAnalysisResult),
    ).resolves.toMatchObject({
      error: "Analysis failed",
      code: "capability_unavailable",
      details: {
        selection_reason: "unknown_provider",
        requested_provider_id: "request-provider",
        candidate_ids: ["binary-ninja", "ghidra", "hopper", "ida", "kuna"],
      },
    });
  });
});
