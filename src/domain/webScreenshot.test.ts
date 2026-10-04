import { describe, expect, it } from "vitest";

import {
  captureWebScreenshotInputSchema,
  compareWebScreenshotsInputSchema,
  createWebScreenshotArtifact,
} from "./webScreenshot.js";

describe("inline web screenshots", () => {
  it("rejects removed screenshot size and pixel controls", () => {
    expect(
      captureWebScreenshotInputSchema.safeParse({
        cdp_endpoint: "http://127.0.0.1:9222",
        allowed_origins: ["https://app.example.test"],
        target_id: "page-1",
        maximum_image_bytes: 1,
      }).success,
    ).toBe(false);

    const artifact = createWebScreenshotArtifact(Buffer.from("image"));
    expect(
      compareWebScreenshotsInputSchema.safeParse({
        before: artifact,
        after: artifact,
        maximum_pixels: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts a caller-supplied target ID without a length ceiling", () => {
    const targetId = "target-".repeat(100);
    expect(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        allowed_origins: ["https://app.example.test"],
        target_id: targetId,
      }).target_id,
    ).toBe(targetId);
  });
});
