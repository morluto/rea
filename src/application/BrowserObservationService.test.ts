import { describe, expect, it } from "vitest";

import { listBrowserTargetsInputSchema } from "../domain/browserObservation.js";
import { browserCaptureComparisonInputSchema } from "../domain/browserCaptureComparison.js";
import { compareWebScreenshotsInputSchema } from "../domain/webScreenshot.js";
import { BROWSER_TOOL_CONTRACTS } from "../contracts/browserToolContracts.js";
import { CdpBrowserProvider } from "../browser/CdpBrowserProvider.js";
import {
  compareWebCaptureEvidence,
  compareWebScreenshotEvidence,
  listBrowserTargets,
} from "./BrowserObservationService.js";

describe("browser observation service prerequisites", () => {
  it("reports a missing provider without requiring a permission grant", async () => {
    const endpoint = "http://127.0.0.1:9222";
    const origin = "http://[::1]:3000";
    const result = await listBrowserTargets(
      undefined,
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: endpoint,
        allowed_origins: [origin],
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCapabilityUnavailableError",
      },
    });
  });
  it("compares supplied scenarios and PNG artifacts without a CDP endpoint", async () => {
    const browser = new CdpBrowserProvider();
    const captures = await compareWebCaptureEvidence(
      browser,
      browserCaptureComparisonInputSchema.parse(
        example("compare_web_captures"),
      ),
    );
    const screenshots = await compareWebScreenshotEvidence(
      browser,
      compareWebScreenshotsInputSchema.parse(
        example("compare_web_screenshots"),
      ),
    );
    for (const result of [captures, screenshots]) {
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value.parameters).not.toHaveProperty("cdp_endpoint");
    }
  });
});

const example = (name: string) => {
  const input = BROWSER_TOOL_CONTRACTS.find((tool) => tool.name === name)
    ?.examples[0]?.input;
  if (input === undefined) throw new Error(`Missing example for ${name}`);
  return input;
};
