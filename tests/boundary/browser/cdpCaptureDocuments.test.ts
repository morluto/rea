import { expect, it } from "vitest";

import { CdpCaptureCompleteness } from "../../../src/browser/CdpCaptureCompleteness.js";
import {
  captureFrames,
  captureResources,
} from "../../../src/browser/CdpCaptureDocuments.js";

it("reports malformed child frame entries instead of silently completing inventory", () => {
  const completeness = new CdpCaptureCompleteness();
  const captured = captureFrames(
    {
      frameTree: {
        frame: {
          id: "main",
          url: "https://example.test/",
        },
        childFrames: [
          null,
          { frame: { id: "child", url: "https://example.test/child" } },
        ],
      },
    },
    new Set(["https://example.test"]),
    undefined,
    completeness,
  );

  expect(captured.items.map(({ frame_id }) => frame_id)).toEqual([
    "main",
    "child",
  ]);
  expect(completeness.snapshot().unavailable_sections).toContain("frames");
});

it("reports missing top-level frame trees for frame and resource inventories", () => {
  const completeness = new CdpCaptureCompleteness();
  expect(
    captureFrames(
      {},
      new Set(["https://example.test"]),
      undefined,
      completeness,
    ).items,
  ).toEqual([]);
  expect(
    captureResources({}, new Set(["https://example.test"]), completeness).items,
  ).toEqual([]);
  expect(completeness.snapshot().unavailable_sections).toEqual(
    expect.arrayContaining(["frames", "resources"]),
  );
});
