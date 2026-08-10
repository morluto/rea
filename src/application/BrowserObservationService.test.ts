import { describe, expect, it } from "vitest";

import { listBrowserTargetsInputSchema } from "../domain/browserObservation.js";
import { listBrowserTargets } from "./BrowserObservationService.js";
import { createPermissionAuthority } from "./PermissionAuthority.js";

describe("browser observation authorization", () => {
  it("requests loopback authority for an IPv6-only browser origin", async () => {
    const endpoint = "http://127.0.0.1:9222";
    const origin = "http://[::1]:3000";
    const ceiling = {
      capability: "browser_observe" as const,
      roots: [],
      executables: [],
      environment_names: [],
      origins: [endpoint, origin],
      network: "loopback" as const,
      mount: false,
    };
    const authority = await createPermissionAuthority(
      [ceiling],
      [
        {
          ...ceiling,
          grant_id: "administrator:browser_observe",
          lifetime: "administrator",
          operation_identity: null,
          expires_at: null,
        },
      ],
    );
    if (!authority.ok) throw authority.error;

    const result = await listBrowserTargets(
      undefined,
      authority.value,
      listBrowserTargetsInputSchema.parse({
        cdp_endpoint: endpoint,
        allowed_origins: [origin],
        approved: true,
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError" },
    });
  });
});
