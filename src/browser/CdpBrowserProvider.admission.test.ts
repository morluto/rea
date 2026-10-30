import { expect, it } from "vitest";

import { createBrowserObservationProvider } from "../composition/browserObservation.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analyzeWebBundleInputSchema } from "../domain/webBundleAnalysis.js";
import { WebBundleAnalysisAdmission } from "./IsolatedWebBundleAnalyzer.js";

const input = analyzeWebBundleInputSchema.parse({
  cdp_endpoint: "http://127.0.0.1:9",
  target_id: "page-1",
  include_script_sources: true,
});

it("shares a capture limit when browser providers use one admission", async () => {
  const admission = new WebBundleAnalysisAdmission();
  const first = createBrowserObservationProvider(admission);
  const second = createBrowserObservationProvider(admission);
  const pending = first.analyzeBundle(input);
  const blocked = await second.analyzeBundle(input);
  try {
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected the shared admission to refuse");
    expect(projectAnalysisError(blocked.error)).toMatchObject({
      code: "resource_constraint",
      details: {
        resource: "capacity",
        reported_limits: { concurrent_web_bundle_analyses: 1 },
      },
    });
  } finally {
    await pending;
    await Promise.allSettled([first.close?.(), second.close?.()]);
  }
});

it("does not share a capture limit across browser providers", async () => {
  const first = createBrowserObservationProvider();
  const second = createBrowserObservationProvider();
  const pending = first.analyzeBundle(input);
  const other = second.analyzeBundle(input);
  try {
    const blocked = await other;
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("expected capture to fail closed");
    expect(projectAnalysisError(blocked.error).code).not.toBe(
      "resource_constraint",
    );
  } finally {
    await Promise.allSettled([
      pending,
      other,
      first.close?.(),
      second.close?.(),
    ]);
  }
});
