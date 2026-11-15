import { expect, it } from "vitest";
import type { CdpEvent } from "../../../src/browser/CdpConnection.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import { compareWebCapturesInputSchema } from "../../../src/domain/webCaptureDiffSchemas.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

it.each(
  ["about:blank", "about:srcdoc"].flatMap((base) =>
    ["inline", "split"].flatMap((encoding) =>
      ["initial", "event"].flatMap((phase) =>
        [false, true].map((recover) => ({ base, encoding, phase, recover })),
      ),
    ),
  ),
)(
  "keeps temporary document policy separate from fragment identity: $base/$encoding/$phase/$recover",
  async ({ base, encoding, phase, recover }) => {
    let document = phase === "initial" ? "transient" : "old";
    const blank =
      encoding === "split"
        ? { url: base, urlFragment: "#details" }
        : { url: base + "#details" };
    const frame = (origin: string) => ({
      id: "child",
      parentId: "frame-main",
      loaderId: document,
      ...(document === "transient"
        ? blank
        : {
            url: origin + "/child",
            urlFragment: document === "fresh" ? "#current" : "#old",
          }),
    });
    const tool = (name: string) => ({
      name,
      frameId: "child",
      inputSchema: {},
      annotations: {
        readOnly: true,
        untrustedContent: true,
        consequential: false,
        autosubmit: false,
      },
    });
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      eventsBeforeReply: ["WebMCP.enable"],
      commandResult: ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-frame-main",
                  url: origin + "/app",
                },
                childFrames: [{ frame: frame(origin) }],
              },
            }
          : undefined,
      commandEvents: ({ method, sessionId }, origin) => {
        if (method !== "WebMCP.enable") return undefined;
        const scope = sessionId === undefined ? {} : { sessionId };
        const events: CdpEvent[] = [
          {
            method: "WebMCP.toolsAdded",
            ...scope,
            params: { tools: [tool("stale")] },
          },
        ];
        document = "transient";
        if (phase === "event")
          events.push({
            method: "Page.frameNavigated",
            ...scope,
            params: { frame: frame(origin) },
          });
        if (recover) {
          document = "fresh";
          events.push({
            method: "Page.frameNavigated",
            ...scope,
            params: { frame: frame(origin) },
          });
          events.push({
            method: "WebMCP.toolsAdded",
            ...scope,
            params: { tools: [tool("current")] },
          });
        }
        return events;
      },
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const input = {
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    };
    const result = await provider.discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse(input),
    );
    if (!result.ok) throw result.error;
    expect(result.value.tools.items.map(({ name }) => name)).toEqual(
      recover ? ["current"] : [],
    );
    expect(result.value.completeness.policy_filtered_sections).not.toContain(
      "webmcp_tools",
    );
    expect(
      result.value.completeness.attach_limited_sections.includes(
        "webmcp_tools",
      ),
    ).toBe(!recover || phase === "event");
    if (recover)
      expect(result.value.tools.items[0]?.frame_url).toBe(
        browser.allowedOrigin + "/child#current",
      );
    const inspection = await provider.inspectPage(
      inspectWebPageInputSchema.parse(input),
    );
    if (!inspection.ok) throw inspection.error;
    const snapshot = { inspection: inspection.value, webmcp: result.value };
    const compared = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: snapshot,
        after: snapshot,
      }),
    );
    expect(compared.dimensions.webmcp.status).toBe(
      recover && phase === "initial" ? "unchanged" : "unknown",
    );
  },
);

it.each([
  "about:blanker#details",
  "about:srcdoc-other#details",
  "about:blank?policy=1#details",
  "https://foreign.invalid/child#about:blank",
  "allowed",
])("does not broaden temporary document policy: %s", async (rawUrl) => {
  const browser = await startFakeCdpBrowser({
    webMcpTools: true,
    eventsBeforeReply: ["WebMCP.enable"],
    commandResult: ({ method }, origin) =>
      method === "Page.getFrameTree"
        ? {
            frameTree: {
              frame: {
                id: "frame-main",
                loaderId: "loader-frame-main",
                url: origin + "/app",
              },
              childFrames: [
                {
                  frame: {
                    id: "child",
                    loaderId: "loader-child",
                    parentId: "frame-main",
                    url:
                      rawUrl === "allowed"
                        ? origin + "/child#about:blank"
                        : rawUrl,
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
              ...(sessionId === undefined ? {} : { sessionId }),
              params: {
                tools: [{ name: "current", frameId: "child", inputSchema: {} }],
              },
            },
          ]
        : undefined,
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().discoverWebMcpTools(
    discoverWebMcpToolsInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  if (!result.ok) throw result.error;
  expect(result.value.tools.items.map(({ name }) => name)).toEqual(
    rawUrl === "allowed" ? ["current"] : [],
  );
  expect(
    result.value.completeness.policy_filtered_sections.includes("webmcp_tools"),
  ).toBe(rawUrl !== "allowed");
  // The initial allowed child may have unreported pre-attach registrations.
  // A literal #about:blank fragment does not make that coverage complete.
  expect(
    result.value.completeness.attach_limited_sections.includes("webmcp_tools"),
  ).toBe(rawUrl === "allowed");
  if (rawUrl === "allowed")
    expect(result.value.tools.items[0]?.frame_url).toBe(
      browser.allowedOrigin + "/child#about:blank",
    );
});

it.each([
  {
    kind: "missing id with alias",
    event: "Page.frameNavigated",
    fields: { frameId: "child" },
    tools: ["current"],
    invalid: true,
  },
  {
    kind: "non-string id with alias",
    event: "Page.frameNavigated",
    fields: { id: 7, frameId: "child" },
    tools: ["current"],
    invalid: true,
  },
  {
    kind: "empty id",
    event: "Page.frameNavigated",
    fields: { id: "" },
    tools: ["current"],
    invalid: true,
  },
  {
    kind: "non-string parent",
    event: "Page.frameNavigated",
    fields: { id: "child", parentId: 7 },
    tools: [],
    invalid: true,
  },
  {
    kind: "empty parent",
    event: "Page.frameNavigated",
    fields: { id: "child", parentId: "" },
    tools: [],
    invalid: true,
  },
  {
    kind: "null parent",
    event: "Page.frameNavigated",
    fields: { id: "child", parentId: null },
    tools: [],
    invalid: true,
  },
  {
    kind: "non-string committed loader",
    event: "Page.frameNavigated",
    fields: { id: "child", parentId: "frame-main", loaderId: 7 },
    tools: [],
    invalid: true,
  },
  {
    // Another root frame proves the selected document changed, even though
    // the final frame tree shows the selected root again.
    kind: "full navigation becomes root",
    event: "Page.frameNavigated",
    fields: { id: "child" },
    tools: "target_changed",
    invalid: false,
  },
  {
    kind: "within-document navigation keeps parent",
    event: "Page.navigatedWithinDocument",
    fields: { frameId: "child" },
    tools: [],
    invalid: false,
  },
] as const)(
  "uses method-specific frame identity and ancestry: $kind",
  async ({ event, fields, tools, invalid }) => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      eventsBeforeReply: ["WebMCP.enable"],
      commandResult: ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-frame-main",
                  url: origin + "/app",
                },
                childFrames: [
                  {
                    frame: {
                      id: "child",
                      loaderId: "loader-child",
                      parentId: "frame-main",
                      url: origin + "/child",
                    },
                  },
                ],
              },
            }
          : undefined,
      commandEvents: ({ method, sessionId }, origin) => {
        if (method !== "WebMCP.enable") return undefined;
        const scope = sessionId === undefined ? {} : { sessionId };
        const frame = { ...fields, url: origin + "/child" };
        return [
          {
            method: "WebMCP.toolsAdded",
            ...scope,
            params: {
              tools: [{ name: "current", frameId: "child", inputSchema: {} }],
            },
          },
          {
            method: event,
            ...scope,
            params: event === "Page.frameNavigated" ? { frame } : frame,
          },
          ...(!invalid
            ? [
                {
                  method: "Page.frameDetached",
                  ...scope,
                  params: { frameId: "frame-main" },
                },
              ]
            : []),
        ];
      },
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (tools === "target_changed") {
      expect(result).toMatchObject({
        ok: false,
        error: { reason: "target_changed" },
      });
      return;
    }
    if (!result.ok) throw result.error;
    expect(result.value.tools.items.map(({ name }) => name)).toEqual(tools);
    expect(
      result.value.completeness.excluded.some(
        ({ section, reason }) =>
          section === "webmcp_tools" && reason === "invalid_protocol_value",
      ),
    ).toBe(invalid);
  },
);

it("retains the committed loader through same-document updates before a replacement", async () => {
  const browser = await startFakeCdpBrowser({
    webMcpTools: true,
    eventsBeforeReply: ["WebMCP.enable"],
    commandResult: ({ method }, origin) =>
      method === "Page.getFrameTree"
        ? {
            frameTree: {
              frame: {
                id: "frame-main",
                loaderId: "loader-frame-main",
                url: origin + "/app",
              },
              childFrames: [
                {
                  frame: {
                    id: "child",
                    parentId: "frame-main",
                    loaderId: "loader-A",
                    url: origin + "/child",
                  },
                },
              ],
            },
          }
        : undefined,
    commandEvents: ({ method, sessionId }, origin) => {
      if (method !== "WebMCP.enable") return undefined;
      const scope = sessionId === undefined ? {} : { sessionId };
      return [
        {
          method: "WebMCP.toolsAdded",
          ...scope,
          params: {
            tools: [{ name: "old", frameId: "child", inputSchema: {} }],
          },
        },
        {
          method: "Page.navigatedWithinDocument",
          ...scope,
          params: { frameId: "child", url: origin + "/child#updated" },
        },
        {
          method: "Page.frameNavigated",
          ...scope,
          params: {
            frame: {
              id: "child",
              parentId: "frame-main",
              loaderId: "loader-B",
              url: origin + "/child#updated",
            },
          },
        },
      ];
    },
  });
  trackBrowser(browser);
  const result = await new CdpBrowserProvider().discoverWebMcpTools(
    discoverWebMcpToolsInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  if (!result.ok) throw result.error;
  expect(result.value.tools.items).toEqual([]);
  expect(result.value.completeness.excluded).not.toContainEqual(
    expect.objectContaining({
      section: "webmcp_tools",
      reason: "invalid_protocol_value",
    }),
  );
});

// A committed subframe navigation is compared with the frame's document by the
// target session's document owner. Only a proven change removes its tools; an
// unknown comparison keeps them visible but reports them as unverified.
it.each([
  ["a new loader", { loaderId: "loader-B" }, "/child", "removed"],
  ["the same loader", { loaderId: "loader-A" }, "/child", "kept"],
  [
    "the same loader at another URL",
    { loaderId: "loader-A" },
    "/other",
    "kept",
  ],
  ["no loader", {}, "/child", "unverified"],
  ["an empty loader", { loaderId: "" }, "/child", "unverified"],
  ["no loader at another URL", {}, "/other", "unverified"],
] as const)(
  "decides subframe tools after a committed navigation with %s",
  async (_label, loader, path, expected) => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      eventsBeforeReply: ["WebMCP.enable"],
      commandResult: ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-frame-main",
                  url: origin + "/app",
                },
                childFrames: [
                  {
                    frame: {
                      id: "child",
                      parentId: "frame-main",
                      loaderId: "loader-A",
                      url: origin + "/child",
                    },
                  },
                ],
              },
            }
          : undefined,
      commandEvents: ({ method, sessionId }, origin) => {
        if (method !== "WebMCP.enable") return undefined;
        const scope = sessionId === undefined ? {} : { sessionId };
        return [
          {
            method: "WebMCP.toolsAdded",
            ...scope,
            params: {
              tools: [{ name: "old", frameId: "child", inputSchema: {} }],
            },
          },
          {
            method: "Page.frameNavigated",
            ...scope,
            params: {
              frame: {
                id: "child",
                parentId: "frame-main",
                ...loader,
                url: origin + path,
              },
            },
          },
        ];
      },
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.tools.items.map((tool) => tool.name)).toEqual(
      expected === "removed" ? [] : ["old"],
    );
    const unverified = result.value.limitations.filter((limitation) =>
      limitation.startsWith("Document identity could not be established"),
    );
    expect(unverified).toEqual(
      expected === "unverified"
        ? [expect.stringContaining("frames child:")]
        : [],
    );
    if (expected === "unverified")
      expect(result.value.completeness.attach_limited_sections).toContain(
        "webmcp_tools",
      );
  },
);

// Without a subframe in the initial tree, discovery starts with full
// coverage, so only the unverified navigation can mark it limited. A frame
// first seen through a same-document navigation has no known loader, so a
// later commit cannot prove its tools belong to the new document.
it.each([
  ["no loader", {}, true, "committed"],
  ["a known loader", { loaderId: "loader-A" }, false, "committed"],
  [
    "a known loader after a first same-document event",
    { loaderId: "loader-B" },
    true,
    "within_document",
  ],
] as const)(
  "limits coverage for a live subframe's tools after a navigation with %s",
  async (_label, loader, limited, first) => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      eventsBeforeReply: ["WebMCP.enable"],
      commandResult: ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-frame-main",
                  url: origin + "/app",
                },
              },
            }
          : undefined,
      commandEvents: ({ method, sessionId }, origin) => {
        if (method !== "WebMCP.enable") return undefined;
        const scope = sessionId === undefined ? {} : { sessionId };
        const child = (extra: Record<string, unknown>) => ({
          method: "Page.frameNavigated",
          ...scope,
          params: {
            frame: {
              id: "child",
              parentId: "frame-main",
              url: origin + "/child",
              ...extra,
            },
          },
        });
        return [
          first === "committed"
            ? child({ loaderId: "loader-A" })
            : {
                method: "Page.navigatedWithinDocument",
                ...scope,
                params: { frameId: "child", url: origin + "/child" },
              },
          {
            method: "WebMCP.toolsAdded",
            ...scope,
            params: {
              tools: [{ name: "live", frameId: "child", inputSchema: {} }],
            },
          },
          child(loader),
        ];
      },
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.tools.items.map((tool) => tool.name)).toEqual(["live"]);
    expect(
      result.value.completeness.attach_limited_sections.includes(
        "webmcp_tools",
      ),
    ).toBe(limited);
    expect(
      result.value.limitations.filter((limitation) =>
        limitation.startsWith("Document identity could not be established"),
      ),
    ).toEqual(limited ? [expect.stringContaining("frames child:")] : []);
  },
);

// A registration kept across a URL change is the same registration: a later
// update replaces it and a removal deletes it, whatever URL each event saw.
it.each([
  ["an update", "WebMCP.toolsAdded", ["old"]],
  ["a removal", "WebMCP.toolsRemoved", []],
] as const)(
  "applies %s to a subframe tool kept across a URL change",
  async (_label, method, expected) => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      eventsBeforeReply: ["WebMCP.enable"],
      commandResult: ({ method: command }, origin) =>
        command === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-frame-main",
                  url: origin + "/app",
                },
                childFrames: [
                  {
                    frame: {
                      id: "child",
                      parentId: "frame-main",
                      loaderId: "loader-A",
                      url: origin + "/child",
                    },
                  },
                ],
              },
            }
          : undefined,
      commandEvents: ({ method: command, sessionId }, origin) => {
        if (command !== "WebMCP.enable") return undefined;
        const scope = sessionId === undefined ? {} : { sessionId };
        const tools = (description: string) => ({
          tools: [
            { name: "old", frameId: "child", description, inputSchema: {} },
          ],
        });
        return [
          { method: "WebMCP.toolsAdded", ...scope, params: tools("first") },
          {
            method: "Page.frameNavigated",
            ...scope,
            params: {
              frame: {
                id: "child",
                parentId: "frame-main",
                loaderId: "loader-A",
                url: origin + "/other",
              },
            },
          },
          { method, ...scope, params: tools("second") },
        ];
      },
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!result.ok) throw result.error;
    expect(result.value.tools.total).toBe(expected.length);
    expect(
      result.value.tools.items.map((tool) => [tool.name, tool.description]),
    ).toEqual(expected.map((name) => [name, "second"]));
  },
);
