import { expect, it } from "vitest";

import { compareWebEvidence } from "./WebComparisonEvidence.js";
import { compareWebCaptureEvidence } from "./BrowserObservationService.js";
import { isComparisonEvidenceOperation } from "../domain/comparisonEvidenceIdentity.js";
import { ok } from "../domain/result.js";
import type { Evidence } from "../domain/evidence.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import { verifyReconstruction } from "../domain/reconstructionVerification.js";
import {
  webVerificationScenario,
  webVerificationCapture,
  webVerificationImage,
} from "../domain/reconstructionWebVerification.fixture.js";
import {
  webCaptureComparisonRequestSchema,
  webScreenshotComparisonRequestSchema,
} from "../contracts/webComparisonInputContracts.js";

const sources = () =>
  [
    webVerificationScenario(),
    webVerificationScenario({ duration: 2 }),
  ] as const;

it("admits unknown adapter frames at the web owner without expanding other comparison workflows", async () => {
  const [left, right] = sources();
  const frame: unknown = { left, right };
  const result = await compareWebCaptureEvidence(frame);
  expect(result.ok).toBe(true);
  expect(isComparisonEvidenceOperation("compare_web_captures")).toBe(false);
  expect(isComparisonEvidenceOperation("compare_web_screenshots")).toBe(false);
  expect(await compareWebCaptureEvidence(null)).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError" },
  });
});

it("resolves exact retained and inline observations through one authenticated comparison owner", () => {
  const [left, right] = sources();
  const records = new Map(
    [left, right].map((record) => [record.evidence_id, record]),
  );
  const retained: Evidence[][] = [];
  let reads = 0;
  const result = compareWebEvidence(
    "compare_web_captures",
    webCaptureComparisonRequestSchema.parse({
      left: { kind: "retained-evidence", evidence_id: left.evidence_id },
      right,
    }),
    {
      lookup: (id) => {
        reads++;
        return records.get(id);
      },
      retain: (items) => {
        retained.push([...items]);
        return ok(undefined);
      },
    },
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(reads).toBe(1);
  expect(retained[0]?.map(({ evidence_id }) => evidence_id)).toEqual([
    left.evidence_id,
    right.evidence_id,
    result.value.evidence_id,
  ]);
  expect(result.value.evidence_links).toEqual(
    [left.evidence_id, right.evidence_id].sort(),
  );
  expect(
    verifyReconstruction(
      {
        name: "Recorded DOM",
        claims: [
          {
            claim_id: "dom",
            title: "Same DOM",
            kind: "web-scenario",
            dimension: "dom",
            step_id: "wait",
            comparison_evidence_id: result.value.evidence_id,
          },
        ],
      },
      createEvidenceBundle(retained[0] ?? []),
    ).status,
  ).toBe("pass");
});

it("retains a detached comparison and its full input commitment without reconstruction proof", () => {
  const [left, right] = sources();
  const result = compareWebEvidence(
    "compare_web_captures",
    webCaptureComparisonRequestSchema.parse({
      before_scenario: webVerificationCapture(left),
      after_scenario: webVerificationCapture(right),
    }),
  );
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.evidence_links).toEqual([]);
  expect(result.value.parameters.comparison_input_sha256).toMatch(
    /^[a-f0-9]{64}$/u,
  );
  expect(result.value.limitations).toContainEqual(
    expect.stringContaining("cannot verify reconstruction"),
  );
  expect(() =>
    verifyReconstruction(
      {
        name: "Detached",
        claims: [
          {
            claim_id: "dom",
            title: "DOM",
            kind: "web-scenario",
            dimension: "dom",
            comparison_evidence_id: result.value.evidence_id,
          },
        ],
      },
      createEvidenceBundle([result.value]),
    ),
  ).toThrow();
});

it("rejects tampered inline records before retaining either sources or comparison", () => {
  const [left, right] = sources();
  let writes = 0;
  const result = compareWebEvidence(
    "compare_web_captures",
    webCaptureComparisonRequestSchema.parse({
      left,
      right: {
        ...right,
        normalized_result: {
          ...webVerificationCapture(right),
          duration_ms: 77,
        },
      },
    }),
    {
      retain: () => {
        writes++;
        return ok(undefined);
      },
    },
  );
  expect(result).toMatchObject({
    ok: false,
    error: { _tag: "EvidenceIntegrityError" },
  });
  expect(writes).toBe(0);
});

it("preserves a missing exact retained source as an actionable reference error", () => {
  const [left, right] = sources();
  const result = compareWebEvidence(
    "compare_web_captures",
    webCaptureComparisonRequestSchema.parse({
      left,
      right: { kind: "retained-evidence", evidence_id: right.evidence_id },
    }),
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "EvidenceIntegrityError",
      evidenceId: right.evidence_id,
      reason: "missing",
    },
  });
});

it("requires exact scenario screenshot selectors and returns unavailable for absent captured pixels", () => {
  const [left, right] = sources();
  expect(
    compareWebEvidence(
      "compare_web_screenshots",
      webScreenshotComparisonRequestSchema.parse({ left, right }),
    ),
  ).toMatchObject({ ok: false, error: { _tag: "AnalysisInputError" } });
  const absent = webVerificationScenario({ duration: 3, screenshot: null });
  const result = compareWebEvidence(
    "compare_web_screenshots",
    webScreenshotComparisonRequestSchema.parse({
      left,
      right: absent,
      step_id: "wait",
    }),
  );
  expect(result).toMatchObject({
    ok: true,
    value: { normalized_result: { status: "unavailable" } },
  });
});

it("keeps detached PNG comparison independent of a configured browser provider", () => {
  const image = webVerificationImage();
  const result = compareWebEvidence(
    "compare_web_screenshots",
    webScreenshotComparisonRequestSchema.parse({ before: image, after: image }),
  );
  expect(result).toMatchObject({
    ok: true,
    value: { normalized_result: { status: "identical" }, evidence_links: [] },
  });
});
