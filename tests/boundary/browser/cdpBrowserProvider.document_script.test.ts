import { createHash } from "node:crypto";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import { compareWebCapturesInputSchema } from "../../../src/domain/webCaptureDiffSchemas.js";

import { describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import { captureWebScreenshotInputSchema } from "../../../src/domain/webScreenshot.js";
import { observeWebSessionInputSchema } from "../../../src/domain/browserSession.js";
import {
  startFakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
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

it.each(["same-document", "replacement", "malformed"])(
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
        const tools = (name: string) => ({
          method: "WebMCP.toolsAdded",
          sessionId,
          params: { tools: [{ name, frameId: "frame-main" }] },
        });
        return [tools("before"), frame, tools("after")];
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
      expect(
        result.value.tools.items.toSorted((left, right) =>
          left.name.localeCompare(right.name),
        ),
      ).toMatchObject([
        { name: "after", frame_url: `${browser.allowedOrigin}/app#details` },
        { name: "before", frame_url: `${browser.allowedOrigin}/app#details` },
      ]);
    if (kind === "malformed")
      expect(result.value.completeness).toMatchObject({
        unavailable_sections: expect.arrayContaining(["webmcp_tools"]),
        policy_filtered_sections: [],
      });
  },
);

const childLocations = (origin: string) => ({
  allowed: { url: `${origin}/child` },
  missing: {},
  opaque: { url: "about:blank" },
  unparseable: { url: "not-a-url" },
  foreign: { url: "https://foreign.invalid/child" },
});

const discoverWebMcpWithChildReplies = async (
  commandResult: NonNullable<FakeOptions["commandResult"]>,
  commandEvents: NonNullable<FakeOptions["commandEvents"]>,
) => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["WebMCP.enable"],
    commandResult,
    commandEvents,
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
  return { discovery: result.value, origin: browser.allowedOrigin };
};

it.each([false, true])(
  "invalidates malformed child navigation without losing known foreign scope: foreign=%s",
  async (foreign) => {
    const scopes = foreign
      ? (["foreign"] as const)
      : (["allowed", "missing", "opaque", "unparseable"] as const);
    const children = scopes.flatMap((scope) =>
      [false, true].flatMap((blankFirst) =>
        [7, "not-a-fragment"].map((urlFragment, index) => ({
          id: `${scope}-${blankFirst}-${index}`,
          scope,
          blankFirst,
          urlFragment,
        })),
      ),
    );
    const { discovery } = await discoverWebMcpWithChildReplies(
      ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-main",
                  url: `${origin}/app`,
                },
                childFrames: children.map(({ id }) => ({
                  frame: {
                    id,
                    loaderId: id,
                    parentId: "frame-main",
                    url: `${origin}/${id}`,
                  },
                })),
              },
            }
          : undefined,
      ({ method, sessionId }, origin) => {
        if (method !== "WebMCP.enable") return undefined;
        const locations = childLocations(origin);
        return [
          {
            method: "WebMCP.toolsAdded",
            sessionId,
            params: {
              tools: children.map(({ id }) => ({
                name: "stale",
                frameId: id,
                inputSchema: {},
              })),
            },
          },
          ...children.flatMap(({ id, blankFirst, scope, urlFragment }) => {
            const navigate = (location: Record<string, unknown>) => ({
              method: "Page.frameNavigated",
              sessionId,
              params: { frame: { id, parentId: "frame-main", ...location } },
            });
            return [
              ...(blankFirst ? [navigate({ url: "about:blank" })] : []),
              navigate({ ...locations[scope], urlFragment }),
            ];
          }),
        ];
      },
    );
    expect(discovery.tools.items).toEqual([]);
    expect(discovery.completeness.attach_limited_sections).toContain(
      "webmcp_tools",
    );
    expect(discovery.completeness.policy_filtered_sections).toEqual(
      foreign ? ["webmcp_tools"] : [],
    );
    expect(discovery.completeness.excluded).toEqual([
      {
        section: "webmcp_tools",
        reason: "invalid_protocol_value",
        count: foreign ? 4 : 16,
      },
      ...(foreign
        ? [{ section: "webmcp_tools", reason: "out_of_target_scope", count: 4 }]
        : []),
    ]);
  },
);

it.each([
  {
    name: "unreadable",
    scopes: ["allowed", "missing", "opaque", "unparseable"],
    invalid: 9,
    foreign: 0,
    limited: true,
  },
  {
    name: "foreign",
    scopes: ["foreign"],
    invalid: 2,
    foreign: 6,
    limited: false,
  },
  {
    name: "approved",
    scopes: ["allowed"],
    invalid: 0,
    foreign: 0,
    limited: true,
  },
] as const)(
  "keeps $name initial frame coverage distinct during replay",
  async ({ name, scopes, invalid, foreign, limited }) => {
    const children = scopes.flatMap((scope) => {
      const fragments =
        name === "approved"
          ? ["#valid"]
          : scope === "allowed" || scope === "opaque" || scope === "unparseable"
            ? [7, "bad-fragment"]
            : [7, "bad-fragment", "#valid"];
      return fragments.map((urlFragment, index) => ({
        id: `${scope}-${index}`,
        scope,
        urlFragment,
      }));
    });
    const { discovery, origin } = await discoverWebMcpWithChildReplies(
      ({ method }, origin) =>
        method === "Page.getFrameTree"
          ? {
              frameTree: {
                frame: {
                  id: "frame-main",
                  loaderId: "loader-main",
                  url: `${origin}/app`,
                },
                childFrames: children.map(({ id, scope, urlFragment }) => ({
                  frame: {
                    id,
                    parentId: "frame-main",
                    ...childLocations(origin)[scope],
                    urlFragment,
                  },
                })),
              },
            }
          : undefined,
      ({ method, sessionId }) =>
        method === "WebMCP.enable"
          ? [
              {
                method: "WebMCP.toolsAdded",
                sessionId,
                params: {
                  tools: children.map(({ id }) => ({
                    name: "read",
                    frameId: id,
                    inputSchema: {},
                  })),
                },
              },
            ]
          : undefined,
    );
    expect(discovery.tools.items).toMatchObject(
      name === "approved"
        ? [
            {
              name: "read",
              frame_id: "allowed-0",
              frame_url: `${origin}/child#valid`,
            },
          ]
        : [],
    );
    expect(discovery.completeness.attach_limited_sections).toEqual(
      limited ? ["webmcp_tools"] : [],
    );
    expect(discovery.completeness.policy_filtered_sections).toEqual(
      foreign > 0 ? ["webmcp_tools"] : [],
    );
    expect(discovery.completeness.excluded).toEqual([
      ...(invalid > 0
        ? [
            {
              section: "webmcp_tools",
              reason: "invalid_protocol_value",
              count: invalid,
            },
          ]
        : []),
      ...(foreign > 0
        ? [
            {
              section: "webmcp_tools",
              reason: "out_of_target_scope",
              count: foreign,
            },
          ]
        : []),
    ]);
  },
);

describe("CdpBrowserProvider: WebMCP discovery and completeness", () => {
  it("retains the exact passive WebMCP replay across a large frame inventory", async () => {
    const browser = await startFakeCdpBrowser({
      webMcpTools: true,
      extraCollections: true,
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
    expect(result.value.status).toBe("available");
    expect(result.value.tools.total).toBe(3);
    expect(
      result.value.tools.items.toSorted((left, right) =>
        left.name.localeCompare(right.name),
      ),
    ).toMatchObject([
      {
        name: "last_frame_tool",
        frame_id: "webmcp-frame-1000",
        frame_url: `${browser.allowedOrigin}/webmcp-frame/1000`,
      },
      {
        name: "search_orders",
        description: "Search orders; authorization=Bearer tool-secret",
        declaration_kind: "declarative",
        owner_origin: browser.allowedOrigin,
        annotations: {
          read_only: true,
          untrusted_content: true,
          consequential: true,
          autosubmit: false,
        },
        input_schema: {
          type: "object",
          properties: {
            orderId: { type: "string", example: "schema-secret" },
            includeItems: { type: "boolean", default: true },
          },
          required: ["orderId"],
        },
        trust: "page-declared-untrusted",
        registration_source: {
          url: `${browser.allowedOrigin}/app.js?token=tool-source-secret`,
          line: 12,
          column: 4,
        },
      },
      {
        name: "update_order",
        frame_id: "frame-main",
        annotations: {
          read_only: true,
          untrusted_content: true,
          consequential: false,
          autosubmit: false,
        },
        trust: "page-declared-untrusted",
      },
    ]);
    expect(result.value.completeness.excluded).toContainEqual({
      section: "webmcp_tools",
      reason: "out_of_target_scope",
      count: 2,
    });
    expect(result.value.completeness.unavailable_sections).not.toContain(
      "webmcp_tools",
    );
    expect(result.value.completeness.truncated_sections).not.toContain(
      "webmcp_tools",
    );
    expect(JSON.stringify(result.value)).not.toContain("private-tool-secret");
    const methods = browser.commands.map(({ method }) => method);
    expect(methods).toContain("WebMCP.enable");
    expect(methods).toContain("WebMCP.disable");
    expect(methods).toContain("Target.detachFromTarget");
    expect(methods.indexOf("WebMCP.enable")).toBeLessThan(
      methods.indexOf("WebMCP.disable"),
    );
    expect(methods.indexOf("WebMCP.disable")).toBeLessThan(
      methods.indexOf("Target.detachFromTarget"),
    );
    expect(methods).not.toContain("WebMCP.invokeTool");
    expect(methods).not.toContain("Runtime.evaluate");
  });

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
});

it("retains readable replay updates while malformed additions or removals leave equality unknown", async () => {
  let malformed: "added" | "removed" | undefined;
  const registration = {
    name: "read_item",
    frameId: "frame-main",
    inputSchema: { type: "object" },
  };
  const temporary = { name: "temporary_item", frameId: "frame-main" };
  const browser = await startFakeCdpBrowser({
    commandEvents: ({ method, sessionId }) => {
      if (method !== "WebMCP.enable") return undefined;
      const additions = {
        method: "WebMCP.toolsAdded",
        sessionId,
        params: {
          tools:
            malformed === "added"
              ? [registration, null]
              : malformed === "removed"
                ? [registration, temporary]
                : [registration],
        },
      };
      if (malformed !== "removed") return [additions];
      return [
        additions,
        {
          method: "WebMCP.toolsRemoved",
          sessionId,
          params: { tools: [temporary, { name: registration.name }, null] },
        },
      ];
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
  expect(before.tools.items).toMatchObject([
    { name: "read_item", frame_id: "frame-main" },
  ]);
  expect(before.completeness.unavailable_sections).not.toContain(
    "webmcp_tools",
  );
  for (const [event, count] of [
    ["added", 1],
    ["removed", 2],
  ] as const) {
    malformed = event;
    const after = await discover();
    expect(after.tools.items, event).toEqual(before.tools.items);
    expect(after.completeness.unavailable_sections, event).toContain(
      "webmcp_tools",
    );
    expect(after.completeness.excluded, event).toContainEqual({
      section: "webmcp_tools",
      reason: "invalid_protocol_value",
      count,
    });
    const comparison = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: inspection.value, webmcp: before },
        after: { inspection: inspection.value, webmcp: after },
      }),
    );
    expect(comparison.dimensions.webmcp, event).toMatchObject({
      status: "unknown",
      total_changes: 0,
      changes: [],
    });
  }
});

const webMcpSchemaFixtures = () => {
  const declaration = {
    type: "object",
    properties: { value: { type: "string", enum: ["one", "two"] } },
    required: ["value"],
    $ref: "https://untrusted.invalid/schema.json",
    examples: [{ token: "caller-schema-value" }],
  };
  const large = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 5_001 }, (_, index) => [
        `field_${index}`,
        { type: "string" },
      ]),
    ),
    required: ["field_5000"],
  };
  const beforeSchemas = {
    boolean: declaration,
    enum: declaration,
    large,
    order: declaration,
    required: declaration,
    type: declaration,
  };
  const afterSchemas = {
    boolean: false,
    enum: {
      ...declaration,
      properties: { value: { type: "string", enum: ["two", "three"] } },
    },
    large,
    order: {
      examples: declaration.examples,
      $ref: declaration.$ref,
      required: declaration.required,
      properties: { value: { enum: ["one", "two"], type: "string" } },
      type: declaration.type,
    },
    required: { ...declaration, required: [] },
    type: {
      ...declaration,
      properties: { value: { type: "number", enum: ["one", "two"] } },
    },
  };
  return { beforeSchemas, afterSchemas };
};

it("preserves full WebMCP schemas and compares their content independently of key order", async () => {
  const { beforeSchemas, afterSchemas } = webMcpSchemaFixtures();
  let schemas: Record<string, JsonValue> = beforeSchemas;
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["WebMCP.enable"],
    commandEvents: ({ method, sessionId }) =>
      method === "WebMCP.enable"
        ? [
            {
              method: "WebMCP.toolsAdded",
              sessionId,
              params: {
                tools: Object.entries(schemas).map(([name, inputSchema]) => ({
                  name,
                  frameId: "frame-main",
                  inputSchema,
                  annotations: { consequential: false },
                })),
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
  const discover = async (expected: Record<string, JsonValue>) => {
    schemas = expected;
    const result = await provider.discoverWebMcpTools(
      discoverWebMcpToolsInputSchema.parse(input),
    );
    if (!result.ok) throw result.error;
    expect(
      result.value.tools.items.toSorted((left, right) =>
        left.name.localeCompare(right.name),
      ),
    ).toMatchObject(
      Object.keys(expected)
        .sort()
        .map((name) => ({ name, trust: "page-declared-untrusted" })),
    );
    expect(
      Object.fromEntries(
        result.value.tools.items.map(({ name, input_schema }) => [
          name,
          input_schema,
        ]),
      ),
    ).toEqual(expected);
    return result.value;
  };
  const before = await discover(beforeSchemas);
  const after = await discover(afterSchemas);
  const schemaDigest = (capture: typeof before, name: string) =>
    capture.tools.items.find((tool) => tool.name === name)?.input_schema_sha256;
  const declarationDigest =
    "127d24bbafde3105597f59a68270447d22da150ea3f31e8a5cbcca206cc80773";
  const largeDigest =
    "2b5d02f573c523d3d1e4e6faf409974bae648b9cf7e20680678c2387f56873df";
  expect(schemaDigest(before, "order")).toBe(declarationDigest);
  expect(schemaDigest(after, "order")).toBe(declarationDigest);
  expect(schemaDigest(before, "large")).toBe(largeDigest);
  expect(schemaDigest(after, "large")).toBe(largeDigest);
  expect(schemaDigest(after, "boolean")).toBe(
    "fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa",
  );

  const comparison = compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: inspection.value, webmcp: before },
      after: { inspection: inspection.value, webmcp: after },
    }),
  );
  const changed = ["boolean", "enum", "required", "type"].map((name) => {
    const canonicalIdentity = JSON.stringify({
      frame_url: `${browser.allowedOrigin}/app`,
      name,
      owner_origin: browser.allowedOrigin,
    });
    return {
      identity: `webmcp_${createHash("sha256").update(canonicalIdentity).digest("hex")}`,
      change: "modified",
    };
  });
  expect(comparison.dimensions.webmcp).toEqual({
    status: "changed",
    total_changes: 4,
    changes: changed.toSorted((left, right) =>
      left.identity.localeCompare(right.identity),
    ),
    reason: null,
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

it("keeps same-name registrations distinct across owners at the same URL", async () => {
  const owners = ["first", "second", "removed"];
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["WebMCP.enable"],
    commandResult: ({ method }, origin) =>
      method === "Page.getFrameTree"
        ? {
            frameTree: {
              frame: {
                id: "frame-main",
                loaderId: "main-loader",
                url: `${origin}/app`,
              },
              childFrames: owners.map((id) => ({
                frame: {
                  id,
                  parentId: "frame-main",
                  loaderId: id,
                  url: `${origin}/shared`,
                },
              })),
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
                tools: owners.map((frameId) => ({
                  name: "read_item",
                  frameId,
                  description: frameId,
                })),
              },
            },
            {
              method: "WebMCP.toolsAdded",
              sessionId,
              params: {
                tools: [
                  {
                    name: "read_item",
                    frameId: "first",
                    description: "Updated first owner",
                    inputSchema: {},
                  },
                ],
              },
            },
            {
              method: "WebMCP.toolsRemoved",
              sessionId,
              params: { tools: [{ name: "read_item", frameId: "removed" }] },
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
  const annotations = {
    read_only: null,
    untrusted_content: null,
    consequential: null,
    autosubmit: null,
  };
  const tools = result.value.tools.items.toSorted((left, right) =>
    left.frame_id.localeCompare(right.frame_id),
  );
  expect(result.value.tools.total).toBe(2);
  expect(tools).toMatchObject([
    {
      name: "read_item",
      frame_id: "first",
      frame_url: `${browser.allowedOrigin}/shared`,
      description: "Updated first owner",
      input_schema: {},
      input_schema_sha256:
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      annotations,
    },
    {
      name: "read_item",
      frame_id: "second",
      frame_url: `${browser.allowedOrigin}/shared`,
      description: "second",
      input_schema: null,
      input_schema_sha256: null,
      annotations,
    },
  ]);
  expect(new Set(tools.map(({ tool_key }) => tool_key)).size).toBe(2);
  expect(result.value.completeness.unavailable_sections).not.toContain(
    "webmcp_tools",
  );
  expect(result.value.completeness.excluded).toEqual([]);
});

it("retains initial child ancestry uncertainty without excluding valid owners", async () => {
  const children = [
    { id: "omitted-parent" },
    { id: "numeric-parent", parentId: 7 },
    { id: "empty-parent", parentId: "" },
    { id: "valid", parentId: "frame-main" },
  ];
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
              },
              childFrames: children.map((frame) => ({
                frame: { ...frame, url: `${origin}/${frame.id}` },
              })),
            },
          }
        : undefined,
    commandEvents: ({ method, sessionId }) =>
      method === "WebMCP.enable"
        ? [
            {
              method: "WebMCP.toolsAdded",
              sessionId,
              params: { tools: [{ name: "read", frameId: "valid" }] },
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
    { name: "read", frame_id: "valid" },
  ]);
  expect(result.value.completeness.unavailable_sections).toContain(
    "webmcp_tools",
  );
  expect(result.value.completeness.excluded).toEqual([
    { section: "webmcp_tools", reason: "invalid_protocol_value", count: 3 },
  ]);
  expect(result.value.completeness.policy_filtered_sections).toEqual([]);
});
