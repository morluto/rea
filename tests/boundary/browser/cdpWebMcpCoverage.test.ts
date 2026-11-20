import { expect, it } from "vitest";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

it.each(["initial", "final"] as const)(
  "distinguishes an unreadable URL from known foreign scope at the $0 root read",
  async (stage) => {
    let fault: "foreign" | "malformed-approved" | "malformed-foreign" =
      "foreign";
    let replayStarted = false;
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      commandResult: ({ method }, origin) => {
        if (method !== "Page.getFrameTree") return undefined;
        const changed = stage === "initial" || replayStarted;
        return {
          frameTree: {
            frame: {
              id: "frame-main",
              loaderId: "loader-main",
              url:
                changed && fault !== "malformed-approved"
                  ? "https://outside.example/page"
                  : origin + "/app",
              ...(changed && fault !== "foreign" ? { urlFragment: 7 } : {}),
            },
          },
        };
      },
      commandEvents: ({ method }) => {
        if (method === "WebMCP.enable") replayStarted = true;
        return undefined;
      },
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const input = discoverWebMcpToolsInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      observation_ms: 0,
    });
    for (const mode of [
      "foreign",
      "malformed-approved",
      "malformed-foreign",
    ] as const) {
      fault = mode;
      replayStarted = false;
      const result = await provider.discoverWebMcpTools(input);
      if (result.ok) throw new Error(`Expected WebMCP refusal for ${mode}`);
      expect(replayStarted, mode).toBe(stage === "final");
      if (mode === "malformed-approved") {
        expect(result.error, mode).toMatchObject({
          _tag: "BrowserObservationError",
          reason: "protocol_error",
        });
      } else {
        expect(projectAnalysisError(result.error), mode).toMatchObject({
          code: "target_unavailable",
          message: expect.stringContaining("permitted HTTP(S) origin scope"),
          remediation: { action: expect.stringContaining("allowed_origins") },
          details: {
            operation: "discover_webmcp_tools",
            reason: "target_not_allowed",
          },
        });
      }
    }
  },
);

it("retains a valid parameterless registration while rejecting malformed annotations", async () => {
  const browser = await startFakeCdpBrowser({
    commandEvents: ({ method, sessionId }) =>
      method === "WebMCP.enable"
        ? [
            {
              method: "WebMCP.toolsAdded",
              sessionId,
              params: {
                tools: [
                  {
                    name: "parameterless",
                    frameId: "frame-main",
                    annotations: { readOnly: "yes" },
                  },
                ],
              },
            },
          ]
        : undefined,
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().discoverWebMcpTools(
    discoverWebMcpToolsInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  if (!result.ok) throw result.error;
  expect(result.value.tools.items).toMatchObject([
    {
      name: "parameterless",
      frame_id: "frame-main",
      input_schema: null,
      input_schema_sha256: null,
      annotations: { read_only: null },
    },
  ]);
  expect(result.value.completeness.excluded).toContainEqual({
    section: "webmcp_tools",
    reason: "invalid_protocol_value",
    count: 1,
  });
  expect(result.value.completeness.unavailable_sections).toContain(
    "webmcp_tools",
  );
});

it("retains replay and live subframe tools without claiming replay covered older subframe registrations", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }, origin) =>
      method === "Page.getFrameTree"
        ? {
            frameTree: {
              frame: { id: "frame-main", url: origin + "/app" },
              childFrames: [
                {
                  frame: {
                    id: "child",
                    parentId: "frame-main",
                    url: origin + "/child",
                  },
                },
              ],
            },
          }
        : undefined,
    commandEvents: ({ method, sessionId }) =>
      method === "WebMCP.enable"
        ? [
            {
              method: "WebMCP.toolsAdded",
              sessionId,
              params: { tools: [{ name: "replayed", frameId: "frame-main" }] },
            },
            {
              method: "WebMCP.toolsAdded",
              sessionId,
              params: { tools: [{ name: "live-child", frameId: "child" }] },
            },
          ]
        : undefined,
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().discoverWebMcpTools(
    discoverWebMcpToolsInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  if (!result.ok) throw result.error;
  expect(result.value.tools.items.map(({ name }) => name).sort()).toEqual([
    "live-child",
    "replayed",
  ]);
  expect(result.value.completeness.attach_limited_sections).toContain(
    "webmcp_tools",
  );
  expect(result.value.limitations).toContainEqual(
    expect.stringContaining("pre-existing subframe registrations"),
  );
});
