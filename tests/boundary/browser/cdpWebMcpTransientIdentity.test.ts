import { expect, it } from "vitest";
import type { CdpEvent } from "../../../src/browser/CdpConnection.js";
import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import { compareWebCapturesInputSchema } from "../../../src/domain/webCaptureDiffSchemas.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const transientChildren = [
  { id: "blank-inline", location: { url: "about:blank#details" } },
  {
    id: "blank-split",
    location: { url: "about:blank", urlFragment: "#details" },
  },
  { id: "srcdoc-inline", location: { url: "about:srcdoc#details" } },
  {
    id: "srcdoc-split",
    location: { url: "about:srcdoc", urlFragment: "#details" },
  },
];

it.each([
  { phase: "initial", replay: "absent" },
  { phase: "initial", replay: "valid" },
  { phase: "initial", replay: "malformed" },
  { phase: "event", replay: "absent" },
  { phase: "event", replay: "valid" },
] as const)(
  "keeps temporary document policy independent of URL encoding: $phase/$replay",
  async ({ phase, replay }) => {
    let document = phase === "initial" ? "transient" : "old";
    const frames = (origin: string) =>
      transientChildren.map(({ id, location }) => ({
        id,
        parentId: "frame-main",
        loaderId: `${id}-${document}`,
        ...(document === "transient"
          ? location
          : {
              url: `${origin}/${id}`,
              urlFragment: document === "fresh" ? "#current" : "#old",
            }),
      }));
    const registrations = (description: string) =>
      transientChildren.map(({ id }) => ({
        name: `read-${id}`,
        description,
        frameId: id,
      }));
    const browser = await startFakeCdpBrowser({
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
                childFrames: frames(origin).map((frame) => ({ frame })),
              },
            }
          : undefined,
      commandEvents: ({ method, sessionId }, origin) => {
        if (method !== "WebMCP.enable") return undefined;
        const navigationEvents = () =>
          frames(origin).map((frame) => ({
            method: "Page.frameNavigated",
            sessionId,
            params: { frame },
          }));
        const events: CdpEvent[] = [
          {
            method: "WebMCP.toolsAdded",
            sessionId,
            params: { tools: registrations("Stale registration") },
          },
        ];
        document = "transient";
        if (phase === "event") events.push(...navigationEvents());
        if (replay !== "absent") {
          document = "fresh";
          events.push(...navigationEvents(), {
            method: "WebMCP.toolsAdded",
            sessionId,
            params: {
              tools:
                replay === "valid"
                  ? registrations("Current registration")
                  : transientChildren.map(({ id }) => ({ frameId: id })),
            },
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
    expect(
      result.value.tools.items.toSorted((left, right) =>
        left.name.localeCompare(right.name),
      ),
    ).toMatchObject(
      replay === "valid"
        ? transientChildren.map(({ id }) => ({
            name: `read-${id}`,
            frame_id: id,
            frame_url: `${browser.allowedOrigin}/${id}#current`,
            description: "Current registration",
          }))
        : [],
    );
    expect(result.value.completeness.policy_filtered_sections).not.toContain(
      "webmcp_tools",
    );
    if (replay === "malformed")
      expect(result.value.completeness.excluded).toEqual([
        {
          section: "webmcp_tools",
          reason: "invalid_protocol_value",
          count: transientChildren.length,
        },
      ]);
    const complete = replay === "valid" && phase === "initial";
    expect(
      result.value.completeness.attach_limited_sections.includes(
        "webmcp_tools",
      ),
    ).toBe(!complete);
    if (phase !== "initial" || replay === "malformed") return;
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
    expect(compared.dimensions.webmcp).toMatchObject({
      status: complete ? "unchanged" : "unknown",
      total_changes: 0,
      changes: [],
    });
  },
);

it("keeps near-miss temporary URLs outside the approved frame inventory", async () => {
  const rejectedUrls = [
    "about:blanker#details",
    "about:srcdoc-other#details",
    "about:blank?policy=1#details",
    "https://foreign.invalid/child#about:blank",
  ];
  const childIds = rejectedUrls.map((_, index) => `excluded-${index}`);
  const browser = await startFakeCdpBrowser({
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
              childFrames: [...rejectedUrls, origin + "/child#about:blank"].map(
                (url, index) => ({
                  frame: {
                    id: childIds[index] ?? "allowed",
                    loaderId: `loader-${index}`,
                    parentId: "frame-main",
                    url,
                  },
                }),
              ),
            },
          }
        : undefined,
    commandEvents: ({ method, sessionId }) =>
      method === "WebMCP.enable"
        ? [
            {
              method: "WebMCP.toolsAdded",
              sessionId,
              params: {
                tools: [...childIds, "allowed"].map((id) => ({
                  name: `read-${id}`,
                  frameId: id,
                })),
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
  expect(result.value.tools.items).toMatchObject([
    {
      name: "read-allowed",
      frame_id: "allowed",
      frame_url: browser.allowedOrigin + "/child#about:blank",
    },
  ]);
  expect(result.value.completeness.policy_filtered_sections).toContain(
    "webmcp_tools",
  );
  expect(result.value.completeness.attach_limited_sections).toContain(
    "webmcp_tools",
  );
  expect(result.value.completeness.excluded).toEqual([
    { section: "webmcp_tools", reason: "out_of_target_scope", count: 8 },
  ]);
});

const discoverWithChildEvents = async (
  childIds: readonly string[],
  events: (origin: string, sessionId: string | undefined) => CdpEvent[],
) => {
  const browser = await startFakeCdpBrowser({
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
              childFrames: childIds.map((id) => ({
                frame: {
                  id,
                  parentId: "frame-main",
                  loaderId: "loader-A",
                  url: `${origin}/${id}`,
                },
              })),
            },
          }
        : undefined,
    commandEvents: ({ method, sessionId }, origin) =>
      method === "WebMCP.enable" ? events(origin, sessionId) : undefined,
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
  return { result, origin: browser.allowedOrigin };
};

it("invalidates only registrations attributable to malformed committed frame facts", async () => {
  const cases = [
    { id: "missing-id", fields: { frameId: "missing-id" } },
    { id: "numeric-id", fields: { id: 7, frameId: "numeric-id" } },
    { id: "empty-id", fields: { id: "", frameId: "empty-id" } },
    { id: "numeric-parent", fields: { id: "numeric-parent", parentId: 7 } },
    { id: "empty-parent", fields: { id: "empty-parent", parentId: "" } },
    { id: "null-parent", fields: { id: "null-parent", parentId: null } },
    {
      id: "numeric-loader",
      fields: { id: "numeric-loader", parentId: "frame-main", loaderId: 7 },
    },
    { id: "unaffected", fields: undefined },
  ];
  const { result } = await discoverWithChildEvents(
    cases.map(({ id }) => id),
    (origin, sessionId) => [
      {
        method: "WebMCP.toolsAdded",
        sessionId,
        params: {
          tools: cases.map(({ id }) => ({
            name: id,
            frameId: id,
            inputSchema: {},
          })),
        },
      },
      ...cases.flatMap(({ id, fields }) =>
        fields === undefined
          ? []
          : [
              {
                method: "Page.frameNavigated",
                sessionId,
                params: { frame: { ...fields, url: `${origin}/${id}` } },
              },
            ],
      ),
    ],
  );
  if (!result.ok) throw result.error;
  expect(
    result.value.tools.items
      .map(({ name, frame_id }) => [name, frame_id])
      .sort(),
  ).toEqual([
    ["empty-id", "empty-id"],
    ["missing-id", "missing-id"],
    ["numeric-id", "numeric-id"],
    ["unaffected", "unaffected"],
  ]);
  expect(result.value.completeness.excluded).toEqual([
    { section: "webmcp_tools", reason: "invalid_protocol_value", count: 7 },
  ]);
});

it("rejects discovery when a child commits as a new root", async () => {
  const { result } = await discoverWithChildEvents(
    ["child"],
    (origin, sessionId) => [
      {
        method: "Page.frameNavigated",
        sessionId,
        params: { frame: { id: "child", url: origin + "/child" } },
      },
    ],
  );
  expect(result).toMatchObject({
    ok: false,
    error: { reason: "target_changed" },
  });
});

it("retains the child ancestry on same-document navigation so a parent detach removes its tools", async () => {
  const { result } = await discoverWithChildEvents(
    ["child"],
    (origin, sessionId) => [
      {
        method: "WebMCP.toolsAdded",
        sessionId,
        params: {
          tools: [{ name: "current", frameId: "child", inputSchema: {} }],
        },
      },
      {
        method: "Page.navigatedWithinDocument",
        sessionId,
        params: { frameId: "child", url: origin + "/child" },
      },
      {
        method: "Page.frameDetached",
        sessionId,
        params: { frameId: "frame-main" },
      },
    ],
  );
  if (!result.ok) throw result.error;
  expect(result.value.tools.items).toEqual([]);
  expect(result.value.completeness.excluded).toEqual([]);
});

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

it("retains, removes, or marks registrations unverified according to each committed loader", async () => {
  const cases = [
    { id: "new-loader", loaderId: "loader-B" },
    { id: "same-loader", loaderId: "loader-A" },
    { id: "same-new-url", loaderId: "loader-A", path: "/other-same" },
    { id: "missing-loader" },
    { id: "empty-loader", loaderId: "" },
    { id: "missing-new-url", path: "/other-missing" },
    { id: "updated", loaderId: "loader-A", path: "/other-update" },
    { id: "removed", loaderId: "loader-A", path: "/other-remove" },
  ];
  const { result, origin } = await discoverWithChildEvents(
    cases.map(({ id }) => id),
    (origin, sessionId) => [
      {
        method: "WebMCP.toolsAdded",
        sessionId,
        params: {
          tools: cases.map(({ id }) => ({
            name: "read",
            frameId: id,
            description: "Original",
            inputSchema: {},
          })),
        },
      },
      ...cases.map(({ id, loaderId, path }) => ({
        method: "Page.frameNavigated",
        sessionId,
        params: {
          frame: {
            id,
            parentId: "frame-main",
            loaderId,
            url: origin + (path ?? `/${id}`),
          },
        },
      })),
      {
        method: "WebMCP.toolsAdded",
        sessionId,
        params: {
          tools: [
            {
              name: "read",
              frameId: "updated",
              description: "Updated",
              inputSchema: {},
            },
          ],
        },
      },
      {
        method: "WebMCP.toolsRemoved",
        sessionId,
        params: { tools: [{ name: "read", frameId: "removed" }] },
      },
    ],
  );
  if (!result.ok) throw result.error;
  expect(
    result.value.tools.items.toSorted((left, right) =>
      left.frame_id.localeCompare(right.frame_id),
    ),
  ).toMatchObject([
    {
      name: "read",
      frame_id: "empty-loader",
      frame_url: `${origin}/empty-loader`,
      description: "Original",
    },
    {
      name: "read",
      frame_id: "missing-loader",
      frame_url: `${origin}/missing-loader`,
      description: "Original",
    },
    {
      name: "read",
      frame_id: "missing-new-url",
      frame_url: `${origin}/missing-new-url`,
      description: "Original",
    },
    {
      name: "read",
      frame_id: "same-loader",
      frame_url: `${origin}/same-loader`,
      description: "Original",
    },
    {
      name: "read",
      frame_id: "same-new-url",
      frame_url: `${origin}/same-new-url`,
      description: "Original",
    },
    {
      name: "read",
      frame_id: "updated",
      frame_url: `${origin}/other-update`,
      description: "Updated",
    },
  ]);
  expect(result.value.completeness.attach_limited_sections).toContain(
    "webmcp_tools",
  );
  expect(
    result.value.limitations.filter((text) =>
      text.startsWith("Document identity could not be established"),
    ),
  ).toEqual([
    expect.stringContaining(
      "frames empty-loader, missing-loader, missing-new-url:",
    ),
  ]);
});

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
