import { afterEach, describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../src/domain/browserObservation.js";
import {
  compareWebCaptures,
  compareWebCapturesInputSchema,
} from "../src/domain/webCaptureDiff.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "./fixtures/fakeCdpBrowser.js";

describe("web capture diff", () => {
  const browsers: FakeCdpBrowser[] = [];

  afterEach(async () => {
    await Promise.all(
      browsers.splice(0).map(async (browser) => browser.close()),
    );
  });

  it("reports stable observed changes while preserving unknown dimensions", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const after = structuredClone(captured.value);
    after.scripts.items = [];
    const request = after.network.requests[0];
    if (request !== undefined) request.status = 204;

    const result = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: captured.value },
        after: { inspection: after },
      }),
    );

    expect(result.overall_status).toBe("changed");
    expect(result.dimensions.scripts).toMatchObject({
      status: "changed",
      total_changes: 1,
      changes: [expect.objectContaining({ change: "removed" })],
    });
    expect(result.dimensions.network).toMatchObject({
      status: "changed",
      changes: [expect.objectContaining({ change: "modified" })],
    });
    expect(result.dimensions.webmcp).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
  });

  it("does not claim unchanged when a relevant section is incomplete", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const incomplete = structuredClone(captured.value);
    incomplete.completeness.truncated_sections.push("dom");

    const result = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: incomplete },
        after: { inspection: captured.value },
      }),
    );

    expect(result.dimensions.dom_structure.status).toBe("unknown");
    expect(result.dimensions.dom_structure.reason).toContain("incomplete");
  });

  it("ignores transient request IDs and capture-approval state", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        approved: true,
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const after = structuredClone(captured.value);
    const request = after.network.requests[0];
    if (request !== undefined) request.request_id = "different-cdp-request-id";
    const response = after.metadata.responses[0];
    if (response !== undefined)
      response.request_id = "different-cdp-request-id";
    const script = after.scripts.items[0];
    if (script !== undefined && !script.source.included)
      script.source.reason = "different approval explanation";
    markSectionsComplete(captured.value, ["scripts", "metadata"]);
    markSectionsComplete(after, ["scripts", "metadata"]);

    const result = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: captured.value },
        after: { inspection: after },
      }),
    );

    expect(result.dimensions.scripts.status).toBe("unchanged");
    expect(result.dimensions.metadata.status).toBe("unchanged");
    expect(result.dimensions.network.status).toBe("unknown");
    expect(result.dimensions.network.total_changes).toBe(0);
  });
});

const markSectionsComplete = (
  inspection: {
    completeness: {
      policy_filtered_sections: string[];
      attach_limited_sections: string[];
      truncated_sections: string[];
      unavailable_sections: string[];
    };
  },
  sections: readonly string[],
): void => {
  const completed = new Set(sections);
  for (const key of [
    "policy_filtered_sections",
    "attach_limited_sections",
    "truncated_sections",
    "unavailable_sections",
  ] as const)
    inspection.completeness[key] = inspection.completeness[key].filter(
      (section) => !completed.has(section),
    );
};
