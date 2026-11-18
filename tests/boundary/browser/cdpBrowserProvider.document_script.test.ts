import { digestCanonicalValue } from "../../../src/domain/canonicalDigest.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import { compareWebCapturesInputSchema } from "../../../src/domain/webCaptureDiffSchemas.js";

import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import { startFakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

it("preserves CDP's separate frame fragment in all passive URL projections", async () => {
  const browser = await startFakeCdpBrowser({
    commandResult: ({ method }, origin) =>
      method === "Page.getFrameTree"
        ? {
            frameTree: {
              frame: {
                id: "frame-main",
                loaderId: "loader-main",
                url: `${origin}/app?token=frame-secret`,
                urlFragment: "#details",
              },
            },
          }
        : undefined,
  });
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  const input = {
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
  };
  const inspected = await provider.inspectPage(
    inspectWebPageInputSchema.parse(input),
  );
  const screenshot = await provider.captureScreenshot(
    captureWebScreenshotInputSchema.parse({
      cdp_endpoint: input.cdp_endpoint,
      allowed_origins: input.allowed_origins,
      target_id: input.target_id,
    }),
  );
  const observed = await provider.observeSession(
    observeWebSessionInputSchema.parse({ ...input, observation_ms: 1 }),
  );
  if (!inspected.ok) throw inspected.error;
  if (!screenshot.ok) throw screenshot.error;
  if (!observed.ok) throw observed.error;
  const url = `${browser.allowedOrigin}/app?token=frame-secret#details`;
  expect(inspected.value.target.url).toBe(url);
  expect(inspected.value.frames[0]?.url).toBe(url);
  expect(screenshot.value.target.url).toBe(url);
  expect(observed.value.target).toMatchObject({
    initial_url: url,
    final_url: url,
  });
});
it("captures approved accessibility text inline", async () => {
  const browser = await startFakeCdpBrowser();
  trackBrowser(browser);
  const request = inspectWebPageInputSchema.parse({
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
    include_accessibility_text: true,
  });
  const result = await new CdpBrowserProvider().inspectPage(request);

  if (!result.ok) throw result.error;
  expect(result.value.accessibility).toMatchObject({
    text_capture: {
      status: "included",
      retained_bytes: 27,
    },
    nodes: [expect.objectContaining({ name: "Submit report" })],
  });
});

it("gates script source reads and distinguishes empty text from malformed replies", async () => {
  const scriptText = "export const observed = 'source-secret';";
  let malformedReply: Record<string, unknown> | undefined;
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Debugger.enable"],
    commandEvents: (command, origin) =>
      command.method === "Debugger.enable"
        ? ["nonempty", "empty"].map((scriptId) => ({
            method: "Debugger.scriptParsed",
            sessionId: command.sessionId,
            params: {
              scriptId,
              url: `${origin}/${scriptId}.js`,
              hash: scriptId,
              executionContextId: 1,
            },
          }))
        : undefined,
    commandResult: ({ method, params }) =>
      method === "Debugger.getScriptSource"
        ? params.scriptId === "nonempty"
          ? { scriptSource: scriptText }
          : (malformedReply ?? { scriptSource: "" })
        : undefined,
  });
  trackBrowser(browser);
  const provider = new CdpBrowserProvider();
  const input = inspectWebPageInputSchema.parse({
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
  });
  const scriptSources = (
    items: readonly {
      readonly url: string;
      readonly source: unknown;
    }[],
  ) => Object.fromEntries(items.map(({ url, source }) => [url, source]));
  const origin = browser.allowedOrigin;
  const nonempty = `${origin}/nonempty.js`;
  const empty = `${origin}/empty.js`;
  try {
    const unapproved = await provider.inspectPage(input);
    if (!unapproved.ok) throw unapproved.error;
    const omitted = {
      included: false,
      reason: "source capture was not selected",
    };
    expect(scriptSources(unapproved.value.scripts.items)).toEqual({
      [nonempty]: omitted,
      [empty]: omitted,
    });
    expect(unapproved.value.completeness.excluded).toContainEqual({
      section: "script_sources",
      reason: "not_approved",
      count: 2,
    });
    expect(browser.commands.map(({ method }) => method)).not.toContain(
      "Debugger.getScriptSource",
    );

    const approvedInput = { ...input, include_script_sources: true };
    for (const reply of [{}, { scriptSource: null }]) {
      malformedReply = reply;
      const before = browser.commands.length;
      expect(
        await provider.inspectPage(approvedInput),
        JSON.stringify(reply),
      ).toMatchObject({
        ok: false,
        error: {
          operation: "inspect_web_page",
          reason: "protocol_error",
          command: "Debugger.getScriptSource",
          pointer: "/scriptSource",
        },
      });
      const commands = browser.commands.slice(before);
      expect(commands).toContainEqual(
        expect.objectContaining({
          method: "Debugger.getScriptSource",
          params: { scriptId: "empty" },
        }),
      );
      expect(commands.map(({ method }) => method)).toContain(
        "Target.detachFromTarget",
      );
      await expect.poll(() => browser.activeConnectionCount()).toBe(0);
    }

    malformedReply = undefined;
    const approved = await provider.inspectPage(approvedInput);
    if (!approved.ok) throw approved.error;
    expect(scriptSources(approved.value.scripts.items)).toMatchObject({
      [nonempty]: {
        included: true,
        artifact: {
          text: scriptText,
          bytes: 40,
          sha256:
            "73b50401804ea39bee7e36e2067fc3e079c92873bdc3d1e35b578bad72e9e0d3",
        },
      },
      [empty]: {
        included: true,
        artifact: {
          text: "",
          bytes: 0,
          sha256:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
      },
    });
  } finally {
    await provider.close();
  }
});

it.each(["after-replay", "before-replay", "replacement", "malformed"])(
  "keeps split-fragment WebMCP frame identity: %s",
  async (kind) => {
    const browser = await startFakeCdpBrowser({
      eventsBeforeReply: ["WebMCP.enable"],
      commandResult: ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-main",
                  url: `${origin}/app`,
                  urlFragment: "#details",
                },
              },
            }
          : undefined,
      commandEvents: ({ method, sessionId }, origin) => {
        if (method !== "WebMCP.enable") return undefined;
        const frame = {
          method: "Page.frameNavigated",
          ...(sessionId === undefined ? {} : { sessionId }),
          params: {
            frame: {
              id: "frame-main",
              loaderId: kind === "replacement" ? "new-loader" : "loader-main",
              url: `${origin}/app`,
              urlFragment: kind === "malformed" ? 7 : "#details",
            },
          },
        };
        const tools = {
          method: "WebMCP.toolsAdded",
          ...(sessionId === undefined ? {} : { sessionId }),
          params: {
            tools: [
              {
                name: "catalog",
                description: "fixture",
                frameId: "frame-main",
              },
            ],
          },
        };
        return kind === "before-replay"
          ? [frame, tools]
          : kind === "malformed"
            ? [tools, frame, tools]
            : [tools, frame];
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
    // A root navigation to another loader proves the selected document
    // changed, even though the final frame tree shows the selected loader.
    if (kind === "replacement") {
      expect(result).toMatchObject({
        ok: false,
        error: { reason: "target_changed" },
      });
      return;
    }
    if (!result.ok) throw result.error;
    if (kind === "malformed") expect(result.value.tools.items).toEqual([]);
    else
      expect(result.value.tools.items).toEqual([
        expect.objectContaining({
          name: "catalog",
          frame_url: `${browser.allowedOrigin}/app#details`,
        }),
      ]);
    if (kind === "malformed")
      expect(result.value.completeness).toMatchObject({
        unavailable_sections: expect.arrayContaining(["webmcp_tools"]),
        policy_filtered_sections: [],
      });
  },
);

it.each(
  ["foreign", "allowed", "missing", "opaque", "unparseable"].flatMap((scope) =>
    [false, true].flatMap((blankFirst) =>
      [7, "not-a-fragment"].map((fragment) => ({
        scope,
        blankFirst,
        fragment,
      })),
    ),
  ),
)(
  "retains malformed WebMCP event scope: $scope/$blankFirst/$fragment",
  async ({ scope, blankFirst, fragment }) => {
    const browser = await startFakeCdpBrowser({
      eventsBeforeReply: ["WebMCP.enable"],
      commandResult: ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-frame-main",
                  url: `${origin}/app`,
                },
                childFrames: [
                  {
                    frame: {
                      id: "child",
                      loaderId: "loader-child",
                      parentId: "frame-main",
                      url: `${origin}/child`,
                    },
                  },
                ],
              },
            }
          : undefined,
      commandEvents: ({ method, sessionId }, origin) => {
        if (method !== "WebMCP.enable") return undefined;
        const navigation = (frame: Record<string, unknown>) => ({
          method: "Page.frameNavigated",
          ...(sessionId === undefined ? {} : { sessionId }),
          params: { frame: { id: "child", parentId: "frame-main", ...frame } },
        });
        return [
          {
            method: "WebMCP.toolsAdded",
            ...(sessionId === undefined ? {} : { sessionId }),
            params: {
              tools: [{ name: "stale", inputSchema: {}, frameId: "child" }],
            },
          },
          ...(blankFirst ? [navigation({ url: "about:blank" })] : []),
          navigation({
            ...(scope === "missing"
              ? {}
              : {
                  url:
                    scope === "foreign"
                      ? "https://foreign.invalid/child"
                      : scope === "opaque"
                        ? "about:blank"
                        : scope === "unparseable"
                          ? "not-a-url"
                          : `${origin}/child`,
                }),
            urlFragment: fragment,
          }),
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
    expect(result.value.completeness.excluded).toContainEqual({
      section: "webmcp_tools",
      reason: "invalid_protocol_value",
      count: 1,
    });
    // Initial allowed-child replay coverage remains unknown even when a
    // later event positively identifies that child's destination as foreign.
    expect(result.value.completeness.attach_limited_sections).toContain(
      "webmcp_tools",
    );
    expect(
      result.value.completeness.policy_filtered_sections.includes(
        "webmcp_tools",
      ),
    ).toBe(scope === "foreign");
    if (scope === "foreign")
      expect(result.value.completeness.excluded).toContainEqual({
        section: "webmcp_tools",
        reason: "out_of_target_scope",
        count: 1,
      });
  },
);

it.each(
  ["allowed", "foreign", "missing", "opaque", "unparseable"].flatMap((scope) =>
    (scope === "opaque" || scope === "unparseable"
      ? [7, "bad-fragment"]
      : [7, "bad-fragment", "#valid"]
    ).map((fragment) => ({ scope, fragment })),
  ),
)(
  "preserves initial child scope through WebMCP replay: $scope/$fragment",
  async ({ scope, fragment }) => {
    const browser = await startFakeCdpBrowser({
      eventsBeforeReply: ["WebMCP.enable"],
      commandResult: ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-frame-main",
                  url: `${origin}/app`,
                },
                childFrames: [
                  {
                    frame: {
                      id: "child",
                      parentId: "frame-main",
                      ...(scope === "missing"
                        ? {}
                        : {
                            url:
                              scope === "foreign"
                                ? "https://foreign.test/child"
                                : scope === "opaque"
                                  ? "about:blank"
                                  : scope === "unparseable"
                                    ? "not-a-url"
                                    : `${origin}/child`,
                          }),
                      urlFragment: fragment,
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
                  tools: [
                    { name: "child_tool", inputSchema: {}, frameId: "child" },
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
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!result.ok) throw result.error;
    const valid = scope === "allowed" && fragment === "#valid";
    expect(result.value.tools.items.map(({ name }) => name)).toEqual(
      valid ? ["child_tool"] : [],
    );
    if (valid)
      expect(result.value.tools.items[0]?.frame_url).toBe(
        `${browser.allowedOrigin}/child#valid`,
      );
    const uncertain =
      scope === "missing" ||
      scope === "opaque" ||
      scope === "unparseable" ||
      (scope === "allowed" && !valid);
    expect(
      result.value.completeness.attach_limited_sections.includes(
        "webmcp_tools",
      ),
    ).toBe(uncertain || valid);
    expect(
      result.value.completeness.policy_filtered_sections.includes(
        "webmcp_tools",
      ),
    ).toBe(scope === "foreign");
    if (uncertain || fragment !== "#valid")
      expect(result.value.completeness.excluded).toContainEqual(
        expect.objectContaining({
          section: "webmcp_tools",
          reason: "invalid_protocol_value",
        }),
      );
  },
);

describe("CdpBrowserProvider: transient WebMCP frames", () => {
  it("drops stale child tools and reports partial coverage when a blank commit remains", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      webMcpChildTransientBlank: true,
      extraCollections: true,
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
    expect(result.value.tools.items.map(({ name }) => name)).not.toContain(
      "child_tool",
    );
    expect(result.value.completeness.attach_limited_sections).toContain(
      "webmcp_tools",
    );
    // Initial foreign frame and its replay declaration are two exclusions;
    // their count does not describe the transient allowed child.
    expect(result.value.completeness.excluded).toContainEqual({
      section: "webmcp_tools",
      reason: "out_of_target_scope",
      count: 2,
    });
  });

  it("accepts fresh child registrations after a stable frame commit", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      webMcpChildRecoversAfterTransient: true,
      webMcpChildTransientBlank: true,
      extraCollections: true,
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
    expect(result.value.tools.items).toContainEqual(
      expect.objectContaining({ name: "child_tool" }),
    );
    // Fresh registration restores this tool, but cannot recover pre-attach
    // declarations from the initial allowed child frame.
    expect(result.value.completeness.attach_limited_sections).toContain(
      "webmcp_tools",
    );
  });

  it("drops registrations from a child document when that frame commits a replacement", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      webMcpChildNavigatesAllowed: true,
      extraCollections: true,
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
    expect(result.value.tools.items.map(({ name }) => name)).not.toContain(
      "child_tool",
    );
    // The initial foreign frame and the excluded foreign replay declaration
    // are separate observed exclusions; replacing an allowed child adds none.
    expect(result.value.completeness.excluded).toEqual([
      { section: "webmcp_tools", reason: "out_of_target_scope", count: 2 },
    ]);
  });
});

describe("CdpBrowserProvider: WebMCP discovery and completeness", () => {
  it.each([true, false])(
    "discovers untrusted WebMCP declarations with consequential=%s without invoking them",
    async (consequential) => {
      const browser = await startFakeCdpBrowser({
        webMcpTools: true,
        webMcpConsequential: consequential,
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
      expect(result.value).toMatchObject({
        status: "available",
        tools: {
          total: 1,
          items: [
            {
              name: "search_orders",
              description: "Search orders; authorization=Bearer tool-secret",
              declaration_kind: "declarative",
              owner_origin: browser.allowedOrigin,
              annotations: {
                read_only: true,
                untrusted_content: true,
                consequential,
                autosubmit: false,
              },
              trust: "page-declared-untrusted",
              registration_source: {
                url: `${browser.allowedOrigin}/app.js?token=tool-source-secret`,
                line: 12,
                column: 4,
              },
            },
          ],
        },
      });
      expect(result.value.completeness.excluded).toContainEqual(
        expect.objectContaining({
          section: "webmcp_tools",
          reason: "out_of_target_scope",
        }),
      );
      expect(result.value.completeness.unavailable_sections).not.toContain(
        "webmcp_tools",
      );
      const serialized = JSON.stringify(result.value);
      expect(serialized).toContain("tool-secret");
      expect(serialized).toContain("tool-source-secret");
      expect(serialized).toContain("schema-secret");
      expect(serialized).not.toContain("private-tool-secret");
      const methods = browser.commands.map(({ method }) => method);
      expect(methods).toContain("WebMCP.enable");
      expect(methods).toContain("WebMCP.disable");
      expect(methods.indexOf("WebMCP.enable")).toBeLessThan(
        methods.indexOf("WebMCP.disable"),
      );
      expect(methods.indexOf("WebMCP.disable")).toBeLessThan(
        methods.indexOf("Target.detachFromTarget"),
      );
      expect(methods).not.toContain("WebMCP.invokeTool");
      expect(methods).not.toContain("Runtime.evaluate");
    },
  );

  it("reports WebMCP unavailable when the experimental domain is absent", async () => {
    const browser = await startFakeCdpBrowser({
      unsupportedMethods: ["WebMCP.enable"],
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
    expect(result.value.status).toBe("unavailable");
    expect(result.value.tools.items).toEqual([]);
    expect(result.value.completeness.unavailable_sections).toContain(
      "webmcp_tools",
    );
  });

  it("rejects WebMCP evidence when the page leaves its approved origin", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      frameUrlAfterFirstRead: "https://private.example.test/tools",
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

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        operation: "discover_webmcp_tools",
        reason: "target_not_allowed",
      },
    });
    expect(browser.commands.map(({ method }) => method)).not.toContain(
      "WebMCP.invokeTool",
    );
  });
});

describe("CdpBrowserProvider: WebMCP replay inventory", () => {
  it("returns every WebMCP registration in the replay", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      extraCollections: true,
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
    expect(result.value.tools).toMatchObject({
      total: 2,
      items: [expect.any(Object), expect.any(Object)],
    });
    expect(result.value.completeness.truncated_sections).not.toContain(
      "webmcp_tools",
    );
  });

  // Frame count has no ceiling: the last of many authorized frames still
  // contributes its registration.
  it("retains registrations from every authorized frame of a page with many frames", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      webMcpFrameCount: 1_001,
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
    expect(result.value.tools.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "last_frame_tool",
          frame_id: "webmcp-frame-1000",
        }),
      ]),
    );
    expect(result.value.completeness.truncated_sections).not.toContain(
      "webmcp_tools",
    );
  });
});

describe("CdpBrowserProvider WebMCP malformed replay completeness", () => {
  it.each(["toolsAdded", "toolsRemoved"] as const)(
    "keeps malformed %s replay entries from proving WebMCP equality",
    async (malformedEvent) => {
      let malformed = false;
      const registration = {
        name: "read_item",
        frameId: "frame-main",
        inputSchema: { type: "object" },
      };
      const browser = await startFakeCdpBrowser({
        commandEvents: (command) => {
          if (command.method !== "WebMCP.enable") return undefined;
          const events: {
            readonly method: string;
            readonly params: unknown;
            readonly sessionId?: string;
          }[] = [
            {
              method: "WebMCP.toolsAdded",
              ...(command.sessionId === undefined
                ? {}
                : { sessionId: command.sessionId }),
              params: {
                tools:
                  malformed && malformedEvent === "toolsAdded"
                    ? [registration, null]
                    : [registration],
              },
            },
          ];
          if (malformed && malformedEvent === "toolsRemoved")
            events.push({
              method: "WebMCP.toolsRemoved",
              ...(command.sessionId === undefined
                ? {}
                : { sessionId: command.sessionId }),
              params: { tools: [{ name: registration.name }, null] },
            });
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
      const inspection = await provider.inspectPage(
        inspectWebPageInputSchema.parse(input),
      );
      if (!inspection.ok) throw inspection.error;
      const discover = async () => {
        const result = await provider.discoverWebMcpTools(
          discoverWebMcpToolsInputSchema.parse(input),
        );
        if (!result.ok) throw result.error;
        return result.value;
      };
      const before = await discover();
      expect(before.tools.items).toHaveLength(1);
      expect(before.completeness.unavailable_sections).not.toContain(
        "webmcp_tools",
      );

      malformed = true;
      const after = await discover();
      expect(after.tools.items).toHaveLength(1);
      expect(after.completeness.unavailable_sections).toContain("webmcp_tools");
      expect(after.completeness.excluded).toContainEqual(
        expect.objectContaining({
          section: "webmcp_tools",
          reason: "invalid_protocol_value",
        }),
      );
      const comparison = compareWebCaptures(
        compareWebCapturesInputSchema.parse({
          before: { inspection: inspection.value, webmcp: before },
          after: { inspection: inspection.value, webmcp: after },
        }),
      );
      expect(comparison.dimensions.webmcp).toMatchObject({
        status: "unknown",
        total_changes: 0,
      });
    },
  );
});

describe("CdpBrowserProvider WebMCP schema comparison", () => {
  it("compares full untrusted declarations independently of object-key order", async () => {
    const declaration: JsonValue = {
      type: "object",
      properties: { value: { type: "string", enum: ["one", "two"] } },
      required: ["value"],
      $ref: "https://untrusted.invalid/schema.json",
      examples: [{ token: "caller-schema-value" }],
    };
    let inputSchema: JsonValue = declaration;
    const browser = await startFakeCdpBrowser({
      // A root-only replay supplies complete owner correspondence. Foreign
      // filtering and pre-existing child coverage are tested separately above.
      eventsBeforeReply: ["WebMCP.enable"],
      commandEvents: ({ method, sessionId }) =>
        method === "WebMCP.enable"
          ? [
              {
                method: "WebMCP.toolsAdded",
                ...(sessionId === undefined ? {} : { sessionId }),
                params: {
                  tools: [
                    {
                      name: "schema_tool",
                      frameId: "frame-main",
                      inputSchema,
                      annotations: { consequential: false },
                    },
                  ],
                },
              },
            ]
          : undefined,
      commandResult: ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-main",
                  url: `${origin}/app`,
                },
              },
            }
          : undefined,
    });
    trackBrowser(browser);
    const provider = new CdpBrowserProvider();
    const input = {
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    };
    const inspection = await provider.inspectPage(
      inspectWebPageInputSchema.parse(input),
    );
    if (!inspection.ok) throw inspection.error;
    const discover = async () => {
      const result = await provider.discoverWebMcpTools(
        discoverWebMcpToolsInputSchema.parse(input),
      );
      if (!result.ok) throw result.error;
      return result.value;
    };
    const before = await discover();
    expect(before.tools.items[0]).toMatchObject({
      input_schema: declaration,
      input_schema_sha256: digestCanonicalValue(declaration),
      trust: "page-declared-untrusted",
    });
    const compare = async (schema: JsonValue) => {
      inputSchema = schema;
      const after = await discover();
      const diff = compareWebCaptures(
        compareWebCapturesInputSchema.parse({
          before: { inspection: inspection.value, webmcp: before },
          after: { inspection: inspection.value, webmcp: after },
        }),
      );
      return { after, dimension: diff.dimensions.webmcp };
    };
    const reordered = Object.fromEntries(Object.entries(declaration).reverse());
    const equivalent = await compare(reordered);
    expect(equivalent.dimension).toMatchObject({
      status: "unchanged",
      total_changes: 0,
    });
    expect(equivalent.after.tools.items[0]?.input_schema_sha256).toBe(
      before.tools.items[0]?.input_schema_sha256,
    );
    for (const changed of [
      {
        ...declaration,
        properties: { value: { type: "number", enum: ["one", "two"] } },
      },
      { ...declaration, required: [] },
      {
        ...declaration,
        properties: { value: { type: "string", enum: ["two", "three"] } },
      },
      false,
    ]) {
      const result = await compare(changed);
      expect(result.dimension).toMatchObject({
        status: "changed",
        total_changes: 1,
        changes: [expect.objectContaining({ change: "modified" })],
      });
    }
  });

  it("retains every field in a large declared WebMCP input schema", async () => {
    const propertyCount = 5_001;
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      webMcpSchemaPropertyCount: propertyCount,
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
    const tool = result.value.tools.items[0];
    expect(tool?.input_schema).toMatchObject({
      type: "object",
      properties: { field_5000: { type: "string" } },
    });
    if (
      tool?.input_schema === null ||
      typeof tool?.input_schema !== "object" ||
      Array.isArray(tool.input_schema)
    )
      throw new Error("Expected an observed schema object");
    expect(Object.keys(tool.input_schema.properties ?? {})).toHaveLength(
      propertyCount,
    );
    expect(tool.input_schema_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});

describe("CdpBrowserProvider: frame scope and screenshots", () => {
  it("removes WebMCP declarations after their child frame leaves scope", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      extraCollections: true,
      webMcpChildLeavesScope: true,
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
    const names = result.value.tools.items.map(({ name }) => name);
    expect(names).toEqual(
      expect.arrayContaining(["search_orders", "update_order"]),
    );
    expect(names).not.toContain("child_tool");
    expect(names).not.toContain("escaped_child_tool");
    expect(result.value.completeness.policy_filtered_sections).toContain(
      "webmcp_tools",
    );
    expect(JSON.stringify(result.value)).not.toContain(
      "cross-origin-child-secret",
    );
  });

  it("captures an explicitly approved content-addressed viewport screenshot", async () => {
    const browser = await startFakeCdpBrowser();
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );

    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      viewport: { width: 1, height: 1 },
      artifact: {
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        bytes: 70,
        media_type: "image/png",
      },
    });
    expect(browser.commands.map(({ method }) => method)).toContain(
      "Page.captureScreenshot",
    );
  });

  it("discards screenshot pixels when the main frame navigates during capture", async () => {
    const browser = await startFakeCdpBrowser({
      navigateDuringScreenshotUrl: "https://private.example.test/screenshot",
    });
    trackBrowser(browser);
    const result = await new CdpBrowserProvider().captureScreenshot(
      captureWebScreenshotInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "BrowserObservationError",
        operation: "capture_web_screenshot",
        reason: "target_not_allowed",
      },
    });
  });
});

describe("CdpBrowserProvider: complete passive inventories", () => {
  it("returns every frame, resource, worker, accessibility, and storage inventory item", async () => {
    const browser = await startFakeCdpBrowser({ extraCollections: true });
    trackBrowser(browser);
    const request = inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
      include_storage_keys: true,
    });
    const result = await new CdpBrowserProvider().inspectPage(request);
    if (!result.ok) throw result.error;
    expect(result.value.completeness.truncated_sections).toEqual([]);
    expect(result.value.frames.length).toBeGreaterThan(1);
    expect(result.value.resources.length).toBeGreaterThan(1);
    expect(result.value.workers.length).toBeGreaterThan(1);
    expect(result.value.accessibility).toMatchObject({ total_nodes: 4 });
    expect(result.value.accessibility.nodes).toHaveLength(4);
    expect(result.value.storage.local_storage_keys.length).toBeGreaterThan(1);
    expect(result.value.storage.session_storage_keys.length).toBeGreaterThan(1);
    expect(result.value.storage.indexed_db_names).toHaveLength(2);
    expect(result.value.storage.cache_names).toHaveLength(2);
    expect(result.value.storage.content_fingerprints).toEqual([]);
  });
});

describe("CdpBrowserProvider: WebMCP registration owners", () => {
  it.each(["retain", "remove-second"] as const)(
    "keeps same-URL frame owners separate: %s",
    async (mode) => {
      const browser = await startFakeCdpBrowser({
        webMcpSameUrlRegistrations: mode,
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
      const tools = result.value.tools.items;
      expect(tools).toHaveLength(mode === "retain" ? 2 : 1);
      expect(result.value.tools.total).toBe(tools.length);
      // Declarations without annotations report absent hints as null, never
      // collapsed to a declared false.
      for (const tool of tools)
        expect(tool.annotations).toEqual({
          read_only: null,
          untrusted_content: null,
          consequential: null,
          autosubmit: null,
        });
      expect(tools).toContainEqual(
        expect.objectContaining({
          name: "read_item",
          frame_id: "webmcp-frame-0",
          description: "First owner updated",
        }),
      );
      if (mode === "retain") {
        expect(tools).toContainEqual(
          expect.objectContaining({
            name: "read_item",
            frame_id: "webmcp-frame-1",
            description: "Second owner",
          }),
        );
        expect(new Set(tools.map((tool) => tool.tool_key)).size).toBe(2);
        expect(new Set(tools.map((tool) => tool.frame_url)).size).toBe(1);
      }
      expect(browser.commands.map(({ method }) => method)).not.toContain(
        "WebMCP.invokeTool",
      );
      expect(browser.commands.map(({ method }) => method)).not.toContain(
        "Runtime.evaluate",
      );
    },
  );
});

it.each(["initial", "final"])(
  "reports malformed WebMCP %s frame identity as protocol uncertainty",
  async (phase) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }, origin, reads) =>
        method === "Page.getFrameTree" && (phase === "initial" || reads > 1)
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-main",
                  url: `${origin}/app`,
                  urlFragment: 7,
                },
              },
            }
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
    expect(result).toMatchObject({
      ok: false,
      error: { reason: "protocol_error" },
    });
  },
);

it.each([undefined, 7, ""])(
  "retains initial child ancestry uncertainty: %s",
  async (parentId) => {
    const browser = await startFakeCdpBrowser({
      commandResult: ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-frame-main",
                  url: `${origin}/app`,
                },
                childFrames: [
                  {
                    frame: {
                      id: "child",
                      url: `${origin}/child`,
                      ...(parentId === undefined ? {} : { parentId }),
                    },
                  },
                ],
              },
            }
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
    expect(result.value.completeness.excluded).toContainEqual({
      section: "webmcp_tools",
      reason: "invalid_protocol_value",
      count: 1,
    });
    expect(result.value.completeness.policy_filtered_sections).toEqual([]);
  },
);
