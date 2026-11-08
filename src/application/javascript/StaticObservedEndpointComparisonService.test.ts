import { expect, it } from "vitest";
import { compareStaticAndObservedEndpointsEvidence } from "./StaticObservedEndpointComparisonService.js";
import { STATIC_OBSERVED_ENDPOINT_COMPARISON_EXAMPLE } from "../../contracts/javascript/staticObservedEndpointExample.js";
import { createEvidence } from "../../domain/evidence.js";
import { webNetworkCaptureSchema } from "../../domain/webNetworkCapture.js";

it("supports cancellation at a cooperative boundary before publishing a result", async () => {
  const controller = new AbortController();
  const pending = compareStaticAndObservedEndpointsEvidence(
    STATIC_OBSERVED_ENDPOINT_COMPARISON_EXAMPLE,
    undefined,
    { signal: controller.signal },
  );
  controller.abort("stop comparison");
  expect(await pending).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
});

it("admits the combined representation before source authentication can clone it", async () => {
  const result = await compareStaticAndObservedEndpointsEvidence({
    ...STATIC_OBSERVED_ENDPOINT_COMPARISON_EXAMPLE,
    application: {
      ...STATIC_OBSERVED_ENDPOINT_COMPARISON_EXAMPLE.application,
      raw_result: "x".repeat(8 * 1024 * 1024),
    },
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisResourceConstraintError",
      operation: "compare_static_and_observed_endpoints",
    },
  });
});

it("locates malformed retained capture facts at the named consumer input", async () => {
  const capture = createEvidence(
    undefined,
    STATIC_OBSERVED_ENDPOINT_COMPARISON_EXAMPLE.capture.provider,
    {
      operation: "inspect_web_network_capture",
      parameters: { sensitive_value_count: 0 },
      result: {},
      confidence: "observed",
    },
  );
  const result = await compareStaticAndObservedEndpointsEvidence({
    ...STATIC_OBSERVED_ENDPOINT_COMPARISON_EXAMPLE,
    capture,
  });
  expect(result).toMatchObject({
    ok: false,
    error: {
      _tag: "AnalysisInputError",
      operation: "compare_static_and_observed_endpoints",
      issues: expect.arrayContaining([
        expect.objectContaining({
          path: ["capture", "normalized_result", "format"],
        }),
      ]),
    },
  });
});

it.each(["har", "saz"] as const)(
  "keeps static endpoint comparison restricted to HAR captures (%s)",
  async (format) => {
    const example = STATIC_OBSERVED_ENDPOINT_COMPARISON_EXAMPLE;
    const capture = createEvidence(undefined, example.capture.provider, {
      operation: "inspect_web_network_capture",
      parameters: { sensitive_value_count: 0 },
      result: {
        ...webNetworkCaptureSchema.parse(example.capture.normalized_result),
        format,
      },
      confidence: "observed",
    });
    const result = await compareStaticAndObservedEndpointsEvidence({
      ...example,
      capture,
    });
    if (format === "har") expect(result.ok).toBe(true);
    else
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisUnsupportedTargetError",
          operation: "compare_static_and_observed_endpoints",
          reason: "api-surface does not support capture format saz.",
        },
      });
  },
);
