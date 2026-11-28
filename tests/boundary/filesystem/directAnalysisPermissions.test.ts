import { projectCliAnalysisResult } from "../../../src/cli/projectCliAnalysisResult.js";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createStubHopperProject } from "../../fixtures/hopperProjectFile.js";
import { createDirectAnalysis } from "../../../src/composition/directAnalysis.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("direct analysis snapshot files", () => {
  it("forwards the CLI provider selector ahead of the environment preference", async () => {
    const targetPath = await createStubHopperProject("rea-direct-provider-");
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
        candidate_ids: ["ghidra", "hopper", "ida", "kuna"],
      },
    });
  });
});
