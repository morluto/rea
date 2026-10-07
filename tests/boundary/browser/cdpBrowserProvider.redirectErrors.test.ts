import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import type { FakeOptions } from "../../fixtures/fakeCdpBrowserTypes.js";
import { describeBrowser, trackBrowser } from "./cdpBrowserProvider.support.js";

const inspectNetwork = async (options: FakeOptions) => {
  const browser = await startFakeCdpBrowser(options);
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
      include_json_body_shapes: true,
    }),
  );
  if (!result.ok) throw result.error;
  return { browser, inspection: result.value };
};

describeBrowser("CdpBrowserProvider: redirect errors", () => {
  it.each([
    { label: "missing", url: undefined, reason: "invalid_protocol_value" },
    { label: "malformed", url: "http://%", reason: "invalid_protocol_value" },
    {
      label: "unsupported scheme",
      url: "file:///private/redirect",
      reason: "unsupported_url",
    },
  ])("classifies $label redirect response URLs", async ({ url, reason }) => {
    const { inspection } = await inspectNetwork({
      malformedRedirectResponse: true,
      ...(url === undefined ? {} : { redirectResponseUrl: url }),
    });

    expect(inspection.network.requests).toEqual([]);
    expect(inspection.completeness.excluded).toContainEqual({
      section: "network_requests",
      reason,
      count: expect.any(Number),
    });
    const section =
      reason === "unsupported_url"
        ? inspection.completeness.policy_filtered_sections
        : inspection.completeness.unavailable_sections;
    expect(section).toContain("network_requests");
  });

  it.each([
    { label: "null", envelope: null },
    { label: "array", envelope: [] },
    { label: "scalar", envelope: "malformed redirect" },
  ])(
    "preserves prior request for a $label redirect envelope",
    async ({ envelope }) => {
      const { browser, inspection } = await inspectNetwork({
        malformedRedirectResponse: true,
        redirectResponseEnvelope: envelope,
      });

      expect(inspection.network.requests).toHaveLength(1);
      expect(inspection.network.requests[0]).toMatchObject({
        request_id: "request-1",
        url: `${browser.allowedOrigin}/malformed-redirect-prior`,
        status: 201,
        mime_type: "application/json",
        encoded_data_length: null,
        redirects: [
          {
            url: `${browser.allowedOrigin}/api?token=network-secret`,
            response_url: `${browser.allowedOrigin}/api?token=network-secret`,
            request_timestamp: 7,
            redirect_event_timestamp: 8,
          },
        ],
      });
      expect(
        inspection.network.requests[0]?.body_shapes.request,
      ).not.toBeNull();
      expect(inspection.network.requests[0]?.body_shapes.response).toBeNull();
      expect(inspection.network.requests[0]?.body_shapes.status).toBe(
        "partial",
      );
      expect(inspection.metadata.responses).toHaveLength(1);
      expect(inspection.metadata.responses[0]).toMatchObject({
        url: `${browser.allowedOrigin}/malformed-redirect-prior`,
        mime_type: "application/json",
        content_length: 123,
        content_encoding: "gzip",
      });
      expect(inspection.completeness.unavailable_sections).toContain(
        "network_requests",
      );
      expect(inspection.completeness.unavailable_sections).toContain(
        "json_body_shapes",
      );
      expect(inspection.completeness.excluded).toContainEqual({
        section: "network_requests",
        reason: "invalid_protocol_value",
        count: expect.any(Number),
      });
      expect(inspection.completeness.excluded).toContainEqual({
        section: "json_body_shapes",
        reason: "invalid_protocol_value",
        count: expect.any(Number),
      });
      expect(JSON.stringify(inspection.network.requests)).not.toContain(
        "malformed-redirect-final",
      );
    },
  );

  it("keeps authorized prior evidence when the later response URL is disallowed", async () => {
    const { browser, inspection } = await inspectNetwork({
      malformedRedirectResponse: true,
      redirectResponseEnvelope: null,
      responseAfterMalformedUrl:
        "https://private.example.test/late?token=unauthorized-secret",
    });

    expect(inspection.network.requests).toHaveLength(1);
    expect(inspection.network.requests[0]).toMatchObject({
      url: `${browser.allowedOrigin}/malformed-redirect-prior`,
      status: 201,
      mime_type: "application/json",
      encoded_data_length: null,
      body_shapes: { response: null },
    });
    expect(inspection.metadata.responses).toHaveLength(1);
    expect(inspection.metadata.responses[0]?.url).toBe(
      `${browser.allowedOrigin}/malformed-redirect-prior`,
    );
    expect(inspection.completeness.excluded).toContainEqual({
      section: "network_requests",
      reason: "invalid_protocol_value",
      count: expect.any(Number),
    });
    const output = JSON.stringify(inspection);
    expect(output).not.toContain("private.example.test");
    expect(output).not.toContain("unauthorized-secret");
    expect(output).not.toContain("header-secret");
  });
});
