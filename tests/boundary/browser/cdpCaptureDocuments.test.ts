import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

it("reports malformed child frame entries through the CDP boundary", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: (command, origin) =>
      command.method === "Page.getFrameTree"
        ? {
            frameTree: {
              frame: { id: "main", url: `${origin}/` },
              childFrames: [
                null,
                { frame: { id: "child", url: `${origin}/child` } },
              ],
            },
          }
        : undefined,
  });
  trackBrowser(browser);

  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );

  if (!result.ok) throw result.error;
  expect(result.value.frames.map(({ frame_id }) => frame_id)).toEqual([
    "main",
    "child",
  ]);
  expect(result.value.completeness.unavailable_sections).toContain("frames");
});

it("marks a missing resource frame tree incomplete through CDP", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: (command) =>
      command.method === "Page.getResourceTree" ? {} : undefined,
  });
  trackBrowser(browser);

  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );

  if (!result.ok) throw result.error;
  expect(result.value.resources).toEqual([]);
  expect(result.value.completeness.unavailable_sections).toContain("resources");
});

const inspectWithReply = async (
  method: string,
  reply: Readonly<Record<string, unknown>>,
) => {
  const browser = await startFakeCdpBrowser({
    commandResult: (command) => (command.method === method ? reply : undefined),
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  if (!result.ok) throw result.error;
  return result.value;
};

it.each([
  ["an omitted node inventory", {}],
  ["a non-array node inventory", { nodes: { length: 1 } }],
])(
  "records %s from Accessibility.getFullAXTree as an accessibility gap",
  async (_label, reply) => {
    const inspected = await inspectWithReply(
      "Accessibility.getFullAXTree",
      reply,
    );

    expect(inspected.accessibility).toMatchObject({
      total_nodes: 0,
      nodes: [],
    });
    expect(inspected.completeness.unavailable_sections).toContain(
      "accessibility",
    );
    expect(inspected.completeness.excluded).toContainEqual({
      section: "accessibility",
      reason: "invalid_protocol_value",
      count: null,
    });
    expect(inspected.limitations).toContain(
      "Accessibility.getFullAXTree returned a malformed result; the section that reads it is incomplete.",
    );
    // Other sections keep their evidence.
    expect(inspected.dom.total_nodes).toBeGreaterThan(0);
  },
);

it("records a DOM snapshot without documents as a DOM and metadata gap", async () => {
  const inspected = await inspectWithReply("DOMSnapshot.captureSnapshot", {
    strings: [],
    documents: [],
  });

  expect(inspected.dom).toMatchObject({ total_nodes: 0, nodes: [] });
  for (const section of ["dom", "metadata"])
    expect(inspected.completeness.excluded).toContainEqual({
      section,
      reason: "invalid_protocol_value",
      count: null,
    });
  expect(inspected.accessibility.total_nodes).toBeGreaterThan(0);
});
