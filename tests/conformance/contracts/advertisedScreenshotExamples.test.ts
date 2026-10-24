import { describe, expect, it } from "vitest";

import { advertisedInputExamples } from "../../../src/contracts/advertisedInputExamples.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { comparePngScreenshots } from "../../../src/browser/PngVisualDiff.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { compareWebScreenshotsInputSchema } from "../../../src/domain/webScreenshot.js";

/**
 * Every PNG artifact an advertised example carries. The artifact schema proves
 * the digest and byte count; only the comparison parser proves the PNG
 * structure, so a hand-written encoding must pass both to be a usable
 * advertised input (morluto/rea#3938).
 */
const advertisedScreenshotArtifacts = (): readonly JsonValue[] => {
  const artifacts: JsonValue[] = [];
  const visit = (value: JsonValue): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value === null || typeof value !== "object") return;
    if (value.media_type === "image/png") {
      artifacts.push(value);
      return;
    }
    Object.values(value).forEach(visit);
  };
  for (const contract of TOOL_CONTRACTS)
    advertisedInputExamples(contract).forEach(visit);
  return artifacts;
};

describe("advertised screenshot artifacts", () => {
  const artifacts = advertisedScreenshotArtifacts();

  it("keeps the screenshot comparison example advertised", () => {
    // Without examined artifacts the checks below would pass vacuously.
    expect(artifacts.length).toBeGreaterThanOrEqual(2);
  });

  it("admits every advertised artifact through the comparison parser", () => {
    for (const artifact of artifacts) {
      const input = compareWebScreenshotsInputSchema.parse({
        before: artifact,
        after: artifact,
        channel_threshold: 0,
      });
      const result = comparePngScreenshots(input);
      expect(result, JSON.stringify(artifact)).toMatchObject({
        status: "identical",
        changed_pixels: 0,
      });
      expect(result.compared_pixels).toBeGreaterThan(0);
    }
  });
});
