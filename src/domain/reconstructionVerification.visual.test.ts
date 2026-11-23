import { describe, expect, it } from "vitest";

import { createEvidence, type Evidence } from "./evidence.js";
import { createEvidenceBundle } from "./evidenceBundle.js";
import {
  createWebScreenshotArtifact,
  webScreenshotSchema,
} from "./webScreenshot.js";
import { unknownTarget } from "./targetIdentity.js";
import { verifyReconstruction } from "./reconstructionVerification.js";
import { reconstructionVerificationResultSchema } from "./reconstructionVerificationSchemas.js";

const browserProvider = {
  id: "rea-cdp-browser",
  name: "REA Chrome DevTools Protocol observation provider",
  version: "2",
} as const;

// The first two 1x1 images encode the same RGBA pixel with different compression.
const beforePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AAAAAP4BAwD/dUi/yAAAAABJRU5ErkJggg==";
const samePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYGD4BwABAwD/Xb6bfwAAAABJRU5ErkJggg==";
const differentPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNgZGT8DwABDQEDO4rAiwAAAABJRU5ErkJggg==";
const widerPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR42mNgYGD4B8IABf0B/aLhVnkAAAAASUVORK5CYII=";

// This PNG's IDAT zlib stream requests a preset dictionary.
const dictionaryPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEUlEQVR4uwwXAwhjYGBg+AcAAQMA/7BXXg0AAAAASUVORK5CYII=";
const unverifiedDocument = "The captured document could not be verified.";

const screenshot = (
  bytes: string,
  capturedAt: string,
  { limited = false, width = 1 } = {},
): Evidence =>
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
      viewport: { width, height: 1 },
      artifact: createWebScreenshotArtifact(Buffer.from(bytes, "base64")),
      completeness: {
        status: limited ? "attach_limited" : "complete_within_window",
        conditions: [limited ? "attach_limited" : "complete_within_window"],
        policy_filtered_sections: [],
        attach_limited_sections: limited ? ["screenshot"] : [],
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
      limitations: limited ? [unverifiedDocument] : [],
    },
    confidence: "observed",
    authority: "external-service",
  });

const comparison = (
  before: Evidence,
  after: Evidence,
  status: "identical" | "different" | "dimension_mismatch",
  threshold = 0,
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
      channel_threshold: threshold,
    },
    result: {
      before: { width: 1, height: 1 },
      after: {
        width: status === "dimension_mismatch" ? 2 : 1,
        height: 1,
      },
      channel_threshold: threshold,
      limitations: [],
      status,
      ...(status === "identical"
        ? {
            compared_pixels: 1,
            changed_pixels: 0,
            changed_ratio: 0,
            maximum_channel_delta: threshold,
            mean_absolute_channel_delta: threshold,
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

const specification = (
  evidence: Evidence,
  sourceEvidence?: { before_evidence_id: string; after_evidence_id: string },
) => ({
  name: "Visual reconstruction",
  claims: [
    {
      kind: "visual" as const,
      claim_id: "viewport",
      title: "Viewport pixels remain equivalent",
      comparison_evidence_id: evidence.evidence_id,
      dimension: "overall" as const,
      ...(sourceEvidence === undefined
        ? {}
        : { source_evidence: sourceEvidence }),
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
    const before = screenshot(beforePng, "2026-01-01T00:00:00.000Z");
    const after = screenshot(samePng, "2026-01-01T00:00:01.000Z");
    const result = verify(comparison(before, after, "identical"), [
      before,
      after,
    ]);

    expect(result.claims.items).toMatchObject([
      { kind: "visual", status: "pass", observed_status: "unchanged" },
    ]);
    expect(result.summary).toMatchObject({
      total: 1,
      behavioral: 0,
      structural: 0,
      visual: 1,
    });
    expect(
      reconstructionVerificationResultSchema.safeParse({
        ...result,
        summary: { ...result.summary, structural: 1, visual: 0 },
      }).success,
    ).toBe(false);
  });

  it.each([
    ["different", "fail", "changed"],
    ["dimension_mismatch", "unknown", "unknown"],
  ] as const)(
    "projects a %s screenshot diff into reconstruction status",
    (diffStatus, status, observedStatus) => {
      const before = screenshot(beforePng, "2026-01-01T00:00:00.000Z");
      const mismatch = diffStatus === "dimension_mismatch";
      const after = screenshot(
        mismatch ? widerPng : differentPng,
        "2026-01-01T00:00:01.000Z",
        { width: mismatch ? 2 : 1 },
      );
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
});

describe("visual reconstruction capture identity", () => {
  it("rejects an ambiguous artifact-to-capture match", () => {
    const before = screenshot(beforePng, "2026-01-01T00:00:00.000Z");
    const duplicate = screenshot(beforePng, "2026-01-01T00:00:01.000Z");
    const after = screenshot(samePng, "2026-01-01T00:00:02.000Z");

    expect(() =>
      verify(comparison(before, after, "identical"), [
        before,
        duplicate,
        after,
      ]),
    ).toThrow(/does not identify exactly one captured Evidence record/u);
  });

  it.each([false, true])(
    "checks capture pairs independently when they share one comparison (second pair limited: %s)",
    (limited) => {
      const before = screenshot(beforePng, "2026-01-01T00:00:00.000Z");
      const after = screenshot(beforePng, "2026-01-01T00:00:01.000Z");
      const repeatedBefore = screenshot(beforePng, "2026-01-01T00:00:02.000Z", {
        limited,
      });
      const repeatedAfter = screenshot(beforePng, "2026-01-01T00:00:03.000Z");
      const saved = comparison(before, after, "identical");
      const spec = specification(saved, {
        before_evidence_id: before.evidence_id,
        after_evidence_id: after.evidence_id,
      });
      const second = specification(saved, {
        before_evidence_id: repeatedBefore.evidence_id,
        after_evidence_id: repeatedAfter.evidence_id,
      }).claims[0]!;
      const bundle = createEvidenceBundle([
        repeatedAfter,
        after,
        saved,
        before,
        repeatedBefore,
      ]);

      const result = verifyReconstruction(
        {
          ...spec,
          claims: [...spec.claims, { ...second, claim_id: "repeated" }],
        },
        bundle,
      );
      expect(result.claims.items).toMatchObject([
        {
          claim_id: "repeated",
          status: limited ? "unknown" : "pass",
          left_evidence_ids: [repeatedBefore.evidence_id],
          right_evidence_ids: [repeatedAfter.evidence_id],
        },
        {
          claim_id: "viewport",
          status: "pass",
          left_evidence_ids: [before.evidence_id],
          right_evidence_ids: [after.evidence_id],
        },
      ]);
    },
  );

  it.each(["explicit", "inferred"] as const)(
    "rejects the same capture pair when the second selector is %s",
    (selection) => {
      const before = screenshot(beforePng, "2026-01-01T00:00:00.000Z");
      const after = screenshot(samePng, "2026-01-01T00:00:01.000Z");
      const saved = comparison(before, after, "identical");
      const sources = {
        before_evidence_id: before.evidence_id,
        after_evidence_id: after.evidence_id,
      };
      const spec = specification(saved, sources);
      const second = specification(
        saved,
        selection === "explicit" ? sources : undefined,
      ).claims[0]!;

      expect(() =>
        verifyReconstruction(
          {
            ...spec,
            claims: [...spec.claims, { ...second, claim_id: "repeat" }],
          },
          createEvidenceBundle([before, after, saved]),
        ),
      ).toThrow(
        expect.objectContaining({
          issues: expect.arrayContaining([
            expect.objectContaining({
              message: "Claim comparison selectors must be unique",
            }),
          ]),
        }),
      );
    },
  );

  it("rejects an explicit screenshot source whose bytes disagree with that side", () => {
    const before = screenshot(beforePng, "2026-01-01T00:00:00.000Z");
    const after = screenshot(samePng, "2026-01-01T00:00:01.000Z");
    const saved = comparison(before, after, "identical");
    const spec = specification(saved, {
      before_evidence_id: after.evidence_id,
      after_evidence_id: before.evidence_id,
    });

    expect(() =>
      verifyReconstruction(spec, createEvidenceBundle([before, after, saved])),
    ).toThrow(/before capture Evidence does not match its artifact digest/u);
  });
});

describe("visual reconstruction coverage and corroboration", () => {
  it("withholds a visual verdict when capture attribution is incomplete", () => {
    const before = screenshot(beforePng, "2026-01-01T00:00:00.000Z", {
      limited: true,
    });
    const after = screenshot(samePng, "2026-01-01T00:00:01.000Z");
    const result = verify(comparison(before, after, "identical"), [
      before,
      after,
    ]);

    expect(result.claims.items).toMatchObject([
      {
        status: "unknown",
        observed_status: "unchanged",
        limitations: expect.arrayContaining([
          expect.stringMatching(
            /Screenshot coverage is incomplete.*attach_limited/u,
          ),
          expect.stringContaining(unverifiedDocument),
        ]),
      },
    ]);
    expect(result.recommended_probes).toContainEqual(
      expect.objectContaining({ operation: "capture_web_screenshot" }),
    );
  });

  it("requires the retained pixels to corroborate the reported comparison", () => {
    const before = screenshot(beforePng, "2026-01-01T00:00:00.000Z");
    const after = screenshot(differentPng, "2026-01-01T00:00:01.000Z");
    const result = verify(comparison(before, after, "identical"), [
      before,
      after,
    ]);

    expect(result.claims.items).toMatchObject([
      {
        status: "unknown",
        observed_status: "unchanged",
        limitations: [
          "Retained screenshot pixels do not corroborate the recorded comparison.",
        ],
      },
    ]);
    expect(
      verify(comparison(before, after, "identical", 1), [before, after]).status,
    ).toBe("pass");
  });
  it.each([
    ["invalid signature", "bm90LWEtcG5n", "Invalid PNG signature"],
    ["preset dictionary", dictionaryPng, "Invalid PNG image data"],
  ])(
    "preserves other claims when retained PNG bytes cannot be decoded (%s)",
    (_defect, bytes, reason) => {
      const before = screenshot(beforePng, "2026-01-01T00:00:00.000Z");
      const after = screenshot(bytes, "2026-01-01T00:00:01.000Z");
      const independent = screenshot(samePng, "2026-01-01T00:00:02.000Z");
      const unreadable = comparison(before, after, "identical");
      const readable = comparison(before, independent, "identical");
      const spec = specification(unreadable);
      const result = verifyReconstruction(
        {
          ...spec,
          claims: [
            ...spec.claims,
            { ...specification(readable).claims[0], claim_id: "independent" },
          ],
        },
        createEvidenceBundle([
          before,
          after,
          independent,
          unreadable,
          readable,
        ]),
      );

      expect(result.claims.items).toMatchObject([
        { claim_id: "independent", status: "pass" },
        {
          claim_id: "viewport",
          status: "unknown",
          limitations: [
            `Retained screenshot comparison could not be replayed: ${reason}`,
          ],
        },
      ]);
    },
  );
});
