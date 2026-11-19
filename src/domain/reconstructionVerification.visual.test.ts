import { describe, expect, it } from "vitest";

import { createEvidence, parseEvidence, type Evidence } from "./evidence.js";
import { createEvidenceBundle } from "./evidenceBundle.js";
import {
  createWebScreenshotArtifact,
  webScreenshotSchema,
} from "./webScreenshot.js";
import { unknownTarget } from "./targetIdentity.js";
import { verifyReconstruction } from "./reconstructionVerification.js";

const browserProvider = {
  id: "rea-cdp-browser",
  name: "REA Chrome DevTools Protocol observation provider",
  version: "2",
} as const;

const screenshot = (bytes: string, capturedAt: string): Evidence =>
  createEvidence(unknownTarget("not-observed"), browserProvider, {
    predicateType: "rea.web-screenshot",
    operation: "capture_web_screenshot",
    parameters: {},
    result: {
      browser: {
        product: "Chrome/130",
        protocol_version: "1.3",
        revision: "fixture",
        user_agent: "fixture",
        js_version: "fixture",
      },
      target: {
        target_id: "fixture-page",
        url: "https://example.test/",
        origin: "https://example.test",
      },
      captured_at: capturedAt,
      viewport: { width: 1, height: 1 },
      artifact: createWebScreenshotArtifact(Buffer.from(bytes)),
      completeness: {
        status: "complete_within_window",
        conditions: ["complete_within_window"],
        policy_filtered_sections: [],
        attach_limited_sections: [],
        truncated_sections: [],
        unavailable_sections: [],
        excluded: [],
        dropped_events: {
          scripts: 0,
          network_requests: 0,
          console_events: 0,
          websocket_connections: 0,
          websocket_frames: 0,
          webmcp_tools: 0,
          timeline_events: 0,
          total: 0,
        },
      },
      limitations: [],
    },
    confidence: "observed",
    authority: "external-service",
  });

const comparison = (
  before: Evidence,
  after: Evidence,
  status: "identical" | "different" | "dimension_mismatch",
): Evidence =>
  createEvidence(unknownTarget("not-observed"), browserProvider, {
    predicateType: "rea.web-screenshot-diff",
    operation: "compare_web_screenshots",
    parameters: {
      before_artifact_sha256: webScreenshotSchema.parse(
        before.normalized_result,
      ).artifact.sha256,
      after_artifact_sha256: webScreenshotSchema.parse(after.normalized_result)
        .artifact.sha256,
      channel_threshold: 0,
    },
    result: {
      before: { width: 1, height: 1 },
      after: {
        width: status === "dimension_mismatch" ? 2 : 1,
        height: 1,
      },
      channel_threshold: 0,
      limitations: [],
      status,
      ...(status === "identical"
        ? {
            compared_pixels: 1,
            changed_pixels: 0,
            changed_ratio: 0,
            maximum_channel_delta: 0,
            mean_absolute_channel_delta: 0,
          }
        : status === "different"
          ? {
              compared_pixels: 1,
              changed_pixels: 1,
              changed_ratio: 1,
              maximum_channel_delta: 1,
              mean_absolute_channel_delta: 1,
            }
          : {
              compared_pixels: 0,
              changed_pixels: null,
              changed_ratio: null,
              maximum_channel_delta: null,
              mean_absolute_channel_delta: null,
            }),
    },
    confidence: "derived",
    authority: "analyst-inference",
  });

const specification = (evidence: Evidence) => ({
  name: "Visual reconstruction",
  claims: [
    {
      kind: "visual" as const,
      claim_id: "viewport",
      title: "Viewport pixels remain equivalent",
      comparison_evidence_id: evidence.evidence_id,
      dimension: "overall" as const,
    },
  ],
});

const verify = (comparisonEvidence: Evidence, sources: Evidence[]) =>
  verifyReconstruction(
    specification(comparisonEvidence),
    createEvidenceBundle([...sources, comparisonEvidence]),
  );

describe("visual reconstruction evidence", () => {
  it("accepts a screenshot comparison and matches its source artifacts", () => {
    const before = screenshot("before", "2026-01-01T00:00:00.000Z");
    const after = screenshot("after", "2026-01-01T00:00:01.000Z");
    const result = verify(comparison(before, after, "identical"), [
      before,
      after,
    ]);

    expect(result.claims.items).toMatchObject([
      { kind: "visual", status: "pass", observed_status: "unchanged" },
    ]);
  });

  it.each([
    ["different", "fail", "changed"],
    ["dimension_mismatch", "unknown", "unknown"],
  ] as const)(
    "projects a %s screenshot diff into reconstruction status",
    (diffStatus, status, observedStatus) => {
      const before = screenshot("before", "2026-01-01T00:00:00.000Z");
      const after = screenshot("after", "2026-01-01T00:00:01.000Z");
      const result = verify(comparison(before, after, diffStatus), [
        before,
        after,
      ]);

      expect(result.claims.items).toMatchObject([
        { kind: "visual", status, observed_status: observedStatus },
      ]);
      if (diffStatus === "dimension_mismatch")
        expect(result.recommended_probes).toContainEqual(
          expect.objectContaining({ operation: "capture_web_screenshot" }),
        );
    },
  );

  it("rejects an ambiguous artifact-to-capture match", () => {
    const before = screenshot("before", "2026-01-01T00:00:00.000Z");
    const duplicate = screenshot("before", "2026-01-01T00:00:01.000Z");
    const after = screenshot("after", "2026-01-01T00:00:02.000Z");

    expect(() =>
      verify(comparison(before, after, "identical"), [
        before,
        duplicate,
        after,
      ]),
    ).toThrow(/does not identify exactly one captured Evidence record/u);
  });

  it("parses the retained records before verification", () => {
    const before = screenshot("before", "2026-01-01T00:00:00.000Z");
    const after = screenshot("after", "2026-01-01T00:00:01.000Z");
    const comparisonEvidence = comparison(before, after, "identical");

    expect(parseEvidence(comparisonEvidence).operation).toBe(
      "compare_web_screenshots",
    );
  });
});
