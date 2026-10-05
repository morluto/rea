import { describe, expect, it } from "vitest";

import { listBrowserTargetsInputSchema } from "../domain/browserObservation.js";
import { listBrowserTargets } from "./BrowserObservationService.js";

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
});
