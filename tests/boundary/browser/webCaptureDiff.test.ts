import { afterEach, describe, expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import {
  type WebPageInspection,
  webPageInspectionSchema,
} from "../../../src/domain/browserObservationSchemas.js";
import { discoverWebMcpToolsInputSchema } from "../../../src/domain/webMcpDiscovery.js";
import { compareWebCaptures } from "../../../src/domain/webCaptureDiff.js";
import {
  compareWebCapturesInputSchema,
  webCaptureDiffSchema,
} from "../../../src/domain/webCaptureDiffSchemas.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";

const browsers: FakeCdpBrowser[] = [];

const inspectStorage = async (
  browser: FakeCdpBrowser,
  fingerprints = false,
) => {
  const captured = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
      include_storage_keys: true,
      include_storage_fingerprints: fingerprints,
    }),
  );
  if (!captured.ok) throw captured.error;
  return captured.value;
};

const compareStorage = (left: WebPageInspection, right: WebPageInspection) =>
  compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: left },
      after: { inspection: right },
    }),
  ).dimensions.storage;

it.each([
  ["local", "DOMStorage.getDOMStorageItems", { entries: [null] }],
  [
    "session",
    "DOMStorage.getDOMStorageItems",
    { entries: [["known", "value"], null] },
  ],
  ["indexed", "IndexedDB.requestDatabaseNames", { databaseNames: [null] }],
  ["cache", "CacheStorage.requestCacheNames", { caches: [null] }],
] as const)(
  "does not invent membership changes after an incomplete %s inventory",
  async (kind, method, malformed) => {
    let failure: "unsupported" | "malformed" | undefined;
    const matches = (command: {
      method: string;
      params: Record<string, unknown>;
    }) => {
      if (command.method !== method) return false;
      if (kind !== "local" && kind !== "session") return true;
      return (
        (command.params.storageId as { isLocalStorage: boolean })
          .isLocalStorage ===
        (kind === "local")
      );
    };
    const browser = await startFakeCdpBrowser({
      commandError: (command) =>
        failure === "unsupported" && matches(command)
          ? { code: -32601, message: "Method not found" }
          : undefined,
      commandResult: (command) =>
        failure === "malformed" && matches(command) ? malformed : undefined,
    });
    browsers.push(browser);
    const before = await inspectStorage(browser);
    expect(before.completeness.unavailable_sections).not.toContain(
      "storage_keys",
    );
    for (const [mode, reason] of [
      ["unsupported", "provider_unavailable"],
      ["malformed", "invalid_protocol_value"],
    ] as const) {
      failure = mode;
      const after = await inspectStorage(browser);
      expect(after.completeness.excluded).toContainEqual({
        section: "storage_keys",
        reason,
        count: null,
      });
      expect(after.completeness.unavailable_sections).toContain("storage_keys");
      for (const [left, right] of [
        [before, after],
        [after, before],
      ] as const)
        expect(compareStorage(left, right)).toMatchObject({
          status: "unknown",
          total_changes: 0,
          changes: [],
        });
      if (kind === "session" && mode === "malformed")
        expect(after.storage.session_storage_keys).toEqual(["known"]);
    }
  },
);

it("preserves shared content changes when a peer inventory is unavailable", async () => {
  let value = "before";
  const browser = await startFakeCdpBrowser({
    unsupportedMethods: ["CacheStorage.requestCacheNames"],
    commandResult: (command) =>
      command.method === "DOMStorage.getDOMStorageItems"
        ? { entries: [["shared-key", value]] }
        : undefined,
  });
  browsers.push(browser);
  const before = await inspectStorage(browser, true);
  expect(before.completeness.unavailable_sections).toContain("storage_keys");
  expect(compareStorage(before, before)).toMatchObject({
    status: "unknown",
    total_changes: 0,
  });
  value = "after";
  const after = await inspectStorage(browser, true);
  for (const [left, right] of [
    [before, after],
    [after, before],
  ] as const)
    expect(compareStorage(left, right)).toMatchObject({
      status: "changed",
      total_changes: 2,
      changes: [
        expect.objectContaining({ change: "modified" }),
        expect.objectContaining({ change: "modified" }),
      ],
    });
  for (const fingerprint of after.storage.content_fingerprints)
    if (["local_storage", "session_storage"].includes(fingerprint.scope))
      fingerprint.complete = false;
  expect(compareStorage(before, after)).toMatchObject({
    status: "unknown",
    total_changes: 0,
  });
});

it("reports complete storage key additions and removals without content fingerprints", async () => {
  const browser = await startFakeCdpBrowser();
  browsers.push(browser);
  const before = await inspectStorage(browser);
  expect(before.storage.fingerprints_complete).toBe(false);
  const after = structuredClone(before);
  after.storage.local_storage_keys.push("new-local");
  after.storage.session_storage_keys.push("new-session");
  after.storage.indexed_db_names.push("new-db");
  after.storage.cache_names.push("new-cache");
  const identities = [
    "storage:cache:new-cache",
    "storage:indexed_db:new-db",
    "storage:local_storage:new-local",
    "storage:session_storage:new-session",
  ];
  for (const [left, right, change] of [
    [before, after, "added"],
    [after, before, "removed"],
  ] as const) {
    expect(compareStorage(left, right)).toMatchObject({
      status: "changed",
      total_changes: 4,
      changes: identities.map((identity) => ({ identity, change })),
    });
  }
  expect(compareStorage(after, after)).toMatchObject({
    status: "unknown",
    total_changes: 0,
  });
  const missingQuota = structuredClone(after);
  missingQuota.storage.quota_bytes = null;
  expect(compareStorage(before, missingQuota)).toMatchObject({
    status: "changed",
    total_changes: 4,
  });
  const partialInventory = structuredClone(after);
  partialInventory.completeness.unavailable_sections.push("storage_keys");
  expect(compareStorage(before, partialInventory)).toMatchObject({
    status: "unknown",
    total_changes: 0,
  });
  expect(compareStorage(partialInventory, before)).toMatchObject({
    status: "unknown",
    total_changes: 0,
  });
});

const expectInvalidDiff = (input: unknown): void => {
  expect(webCaptureDiffSchema.safeParse(input).success).toBe(false);
};

afterEach(async () => {
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
});

it("compares consequential annotations only when both values are retained", async () => {
  const browser = await startFakeCdpBrowser({ webMcpTools: true });
  browsers.push(browser);
  const provider = new CdpBrowserProvider();
  const request = {
    cdp_endpoint: browser.endpoint,
    allowed_origins: [browser.allowedOrigin],
    target_id: "allowed-page",
    observation_ms: 0,
  };
  const inspection = await provider.inspectPage(
    inspectWebPageInputSchema.parse(request),
  );
  if (!inspection.ok) throw inspection.error;
  const discovery = await provider.discoverWebMcpTools(
    discoverWebMcpToolsInputSchema.parse(request),
  );
  if (!discovery.ok) throw discovery.error;
  markSectionsComplete(discovery.value, ["webmcp_tools"]);

  for (const [left, right, editDescription, status] of [
    [undefined, false, false, "unknown"],
    [true, undefined, false, "unknown"],
    [undefined, false, true, "changed"],
    [true, undefined, true, "changed"],
    [true, false, false, "changed"],
    [null, false, false, "changed"],
  ] as const) {
    const before = structuredClone(discovery.value);
    const after = structuredClone(discovery.value);
    const beforeTool = before.tools.items[0];
    const afterTool = after.tools.items[0];
    if (beforeTool === undefined || afterTool === undefined)
      throw new Error("Expected a discovered WebMCP tool");
    if (left === undefined) delete beforeTool.annotations.consequential;
    else beforeTool.annotations.consequential = left;
    if (right === undefined) delete afterTool.annotations.consequential;
    else afterTool.annotations.consequential = right;
    if (editDescription) afterTool.description += " changed";

    const dimension = compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: inspection.value, webmcp: before },
        after: { inspection: inspection.value, webmcp: after },
      }),
    ).dimensions.webmcp;
    expect(dimension).toMatchObject({
      status,
      total_changes: status === "changed" ? 1 : 0,
      changes:
        status === "changed"
          ? [expect.objectContaining({ change: "modified" })]
          : [],
    });
  }
});

describe("web capture dimension uncertainty", () => {
  it("reports stable observed changes while preserving unknown dimensions", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    markSectionsComplete(captured.value, ["scripts", "dom", "frames"]);
    const after = structuredClone(captured.value);
    after.scripts.items = [];
    const request = after.network.requests[0];
    if (request !== undefined) {
      request.status = 204;
      request.redirects = [
        {
          url: `${browser.allowedOrigin}/prior`,
          response_url: `${browser.allowedOrigin}/prior`,
          method: "GET",
          resource_type: "Fetch",
          status: 302,
          mime_type: "text/plain",
          encoded_data_length: 12,
          request_timestamp: 1,
          redirect_event_timestamp: 2,
        },
      ];
    }

    const compareAfter = () =>
      compareWebCaptures(
        compareWebCapturesInputSchema.parse({
          before: { inspection: captured.value },
          after: { inspection: after },
        }),
      );
    const node = after.dom.nodes[0];
    if (node === undefined) throw new Error("Expected a retained DOM node");
    node.node_name = "MAIN";
    expect(compareAfter().dimensions.dom_structure).toMatchObject({
      status: "changed",
      total_changes: 1,
      changes: [{ identity: "document", change: "modified" }],
    });
    after.completeness.truncated_sections.push("dom");
    const result = compareAfter();
    expect(result.dimensions.dom_structure).toMatchObject({
      status: "unknown",
      total_changes: 0,
      changes: [],
    });

    expect(result.overall_status).toBe("changed");
    expect(result.dimensions.scripts).toMatchObject({
      status: "changed",
      total_changes: 1,
      changes: [expect.objectContaining({ change: "removed" })],
    });
    expect(result.dimensions.network).toMatchObject({
      status: "unknown",
      total_changes: 0,
      changes: [],
    });
    expect(result.dimensions.webmcp).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
    expectInvalidDiff({ ...result, overall_status: "unchanged" });
    expectInvalidDiff({
      ...result,
      dimensions: {
        ...result.dimensions,
        webmcp: { ...result.dimensions.webmcp, reason: null },
      },
    });
    expectInvalidDiff({
      ...result,
      dimensions: {
        ...result.dimensions,
        scripts: { ...result.dimensions.scripts, total_changes: 2 },
      },
    });
    const { accessibility: _accessibility, ...missingAccessibility } =
      result.dimensions;
    expectInvalidDiff({
      ...result,
      dimensions: missingAccessibility,
    });
    const { storage: _storage, ...missingStorage } = result.dimensions;
    expectInvalidDiff({ ...result, dimensions: missingStorage });
  });
});

describe("web capture WebSocket comparison", () => {
  it("compares complete ordered WebSocket streams by source URL, not request IDs", async () => {
    const browser = await startFakeCdpBrowser({ binaryWebSocketEvent: true });
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
        include_websocket_shapes: true,
      }),
    );
    if (!captured.ok) throw captured.error;
    const before = structuredClone(captured.value);
    markSectionsComplete(before, [
      "network_requests",
      "websocket_connections",
      "websocket_frames",
      "websocket_shapes",
    ]);
    expect(before.network.websocket_connections).toHaveLength(1);
    expect(before.network.websocket_connections[0]?.url).toBe(
      `ws://${new URL(browser.allowedOrigin).host}/live?token=websocket-url-secret`,
    );
    expect(before.network.websocket_connections[0]?.events).toHaveLength(2);

    const idOnlyChange = structuredClone(before);
    const idOnlyConnection = idOnlyChange.network.websocket_connections[0];
    if (idOnlyConnection === undefined)
      throw new Error("Missing captured WebSocket connection");
    idOnlyConnection.request_id = "capture-local-id-2";
    expect(compareNetwork(before, idOnlyChange)).toMatchObject({
      status: "unchanged",
      total_changes: 0,
    });

    const changeFrame = (
      update: (
        event: WebPageInspection["network"]["websocket_connections"][number]["events"][number],
      ) => void,
    ): WebPageInspection => {
      const changed = structuredClone(before);
      const event = changed.network.websocket_connections[0]?.events[0];
      if (event === undefined)
        throw new Error("Missing captured WebSocket frame");
      update(event);
      return changed;
    };
    const eventChanges: readonly ((
      event: WebPageInspection["network"]["websocket_connections"][number]["events"][number],
    ) => void)[] = [
      (event) => {
        event.direction = "received";
      },
      (event) => {
        event.opcode = 2;
      },
      (event) => {
        event.payload_shape = { format: "binary", json_shape: null };
      },
    ];
    for (const update of eventChanges)
      expect(compareNetwork(before, changeFrame(update)).status).toBe(
        "changed",
      );

    const changed = structuredClone(before);
    const connection = changed.network.websocket_connections[0];
    const event = connection?.events[0];
    if (connection === undefined || event === undefined)
      throw new Error("Missing captured WebSocket frame");
    if (event.payload_bytes === null)
      throw new Error("Expected captured WebSocket byte count");
    connection.request_id = "capture-local-id-3";
    event.direction = "received";
    event.opcode = 2;
    event.payload_bytes += 1;
    event.payload_shape = { format: "binary", json_shape: null };
    expect(compareNetwork(before, changed)).toMatchObject({
      status: "changed",
      changes: [expect.objectContaining({ change: "modified" })],
    });

    const reordered = structuredClone(before);
    reordered.network.websocket_connections[0]?.events.reverse();
    expect(compareNetwork(before, reordered)).toMatchObject({
      status: "changed",
      changes: [expect.objectContaining({ change: "modified" })],
    });

    const addedEmptyConnection = structuredClone(before);
    addedEmptyConnection.network.websocket_connections.push({
      request_id: "new-empty-connection",
      url: before.network.websocket_connections[0]!.url,
      events: [],
    });
    expect(compareNetwork(before, addedEmptyConnection)).toMatchObject({
      status: "changed",
      changes: [expect.objectContaining({ change: "modified" })],
    });
  });
});

describe("web capture WebSocket shape comparison", () => {
  it("aligns WebSocket shape streams only through common known coverage", async () => {
    const browser = await startFakeCdpBrowser({ binaryWebSocketEvent: true });
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
        include_websocket_shapes: true,
      }),
    );
    if (!captured.ok) throw captured.error;
    const before = structuredClone(captured.value);
    markSectionsComplete(before, [
      "network_requests",
      "websocket_connections",
      "websocket_frames",
      "websocket_shapes",
    ]);

    const sameUrlStreams = structuredClone(before);
    sameUrlStreams.network.websocket_connections.push({
      ...structuredClone(sameUrlStreams.network.websocket_connections[0]!),
      request_id: "second-local-id",
    });
    const reorderedConnections = structuredClone(sameUrlStreams);
    reorderedConnections.network.websocket_connections.reverse();
    for (const [
      index,
      item,
    ] of reorderedConnections.network.websocket_connections.entries())
      item.request_id = `new-local-id-${String(index)}`;
    expect(compareNetwork(sameUrlStreams, reorderedConnections)).toMatchObject({
      status: "unchanged",
      total_changes: 0,
    });

    const correlatedBefore = structuredClone(before);
    const correlatedConnection =
      correlatedBefore.network.websocket_connections[0]!;
    const shape = (root_type: "string" | "number") => ({
      format: "json" as const,
      json_shape: {
        root_type,
        node_count: 1,
        max_depth_observed: 0,
        properties: [],
      },
    });
    const firstShape = shape("string");
    const secondShape = shape("number");
    for (const connection of [
      correlatedConnection,
      {
        ...structuredClone(correlatedConnection),
        request_id: "second-correlated-connection",
      },
    ]) {
      connection.events[0]!.payload_shape = structuredClone(firstShape);
      connection.events[1]!.payload_shape = structuredClone(secondShape);
    }
    correlatedBefore.network.websocket_connections = [
      correlatedConnection,
      {
        ...structuredClone(correlatedConnection),
        request_id: "second-correlated-connection",
      },
    ];
    const crossed = structuredClone(correlatedBefore);
    crossed.network.websocket_connections[0]!.events[1]!.payload_shape =
      structuredClone(firstShape);
    crossed.network.websocket_connections[1]!.events[0]!.payload_shape =
      structuredClone(secondShape);
    crossed.network.websocket_connections[1]!.events[1]!.payload_shape =
      structuredClone(firstShape);
    expect(compareNetwork(correlatedBefore, crossed).status).toBe("changed");

    const partialShapes = structuredClone(correlatedBefore);
    partialShapes.network.websocket_connections[0]!.events[1]!.payload_shape =
      null;
    const ambiguousShapeChange = structuredClone(partialShapes);
    ambiguousShapeChange.network.websocket_connections[1]!.events[1]!.payload_shape =
      structuredClone(firstShape);
    expect(compareNetwork(partialShapes, ambiguousShapeChange)).toMatchObject({
      status: "unknown",
      total_changes: 0,
      changes: [],
    });
    const changedKnownShape = structuredClone(partialShapes);
    changedKnownShape.network.websocket_connections[0]!.events[0]!.payload_shape =
      structuredClone(secondShape);
    expect(compareNetwork(partialShapes, changedKnownShape).status).toBe(
      "changed",
    );
  });
});

describe("web capture WebSocket shape coverage", () => {
  it("keeps unchanged unknown when selected WebSocket shapes are unavailable", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
        include_websocket_shapes: true,
      }),
    );
    if (!captured.ok) throw captured.error;
    const unavailable = structuredClone(captured.value);
    markSectionsComplete(unavailable, [
      "network_requests",
      "websocket_connections",
      "websocket_frames",
    ]);
    unavailable.completeness.unavailable_sections.push("websocket_shapes");
    for (const connection of unavailable.network.websocket_connections)
      for (const event of connection.events) event.payload_shape = null;
    expect(
      compareNetwork(unavailable, structuredClone(unavailable)),
    ).toMatchObject({
      status: "unknown",
      total_changes: 0,
      changes: [],
    });

    const observed = structuredClone(unavailable);
    for (const connection of observed.network.websocket_connections)
      for (const event of connection.events)
        event.payload_shape = { format: "binary", json_shape: null };
    for (const [left, right] of [
      [unavailable, observed],
      [observed, unavailable],
    ] as const)
      expect(compareNetwork(left, right)).toMatchObject({
        status: "unknown",
        total_changes: 0,
        changes: [],
      });

    const metadataChanged = structuredClone(observed);
    metadataChanged.network.websocket_connections[0]!.events[0]!.opcode = 2;
    expect(compareNetwork(unavailable, metadataChanged).status).toBe("changed");

    const truncated = structuredClone(observed);
    truncated.network.websocket_connections[0]!.events[0]!.payload_shape = null;
    truncated.completeness.truncated_sections.push("websocket_shapes");
    for (const [left, right] of [
      [truncated, observed],
      [observed, truncated],
    ] as const)
      expect(compareNetwork(left, right)).toMatchObject({
        status: "unknown",
        total_changes: 0,
        changes: [],
      });
  });
});

describe("web capture WebSocket payload byte coverage", () => {
  it("keeps unknown byte counts out of differences while comparing known metadata", async () => {
    const browser = await startFakeCdpBrowser({ binaryWebSocketEvent: true });
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const known = structuredClone(captured.value);
    markSectionsComplete(known, [
      "network_requests",
      "websocket_connections",
      "websocket_frames",
    ]);
    const unknownBytes = structuredClone(known);
    unknownBytes.network.websocket_connections[0]!.events[1]!.payload_bytes =
      null;
    for (const [left, right] of [
      [unknownBytes, known],
      [known, unknownBytes],
    ] as const)
      expect(compareNetwork(left, right)).toMatchObject({
        status: "unknown",
        total_changes: 0,
        changes: [],
      });

    const knownMetadataChanged = structuredClone(unknownBytes);
    knownMetadataChanged.network.websocket_connections[0]!.events[1]!.direction =
      "sent";
    expect(compareNetwork(unknownBytes, knownMetadataChanged).status).toBe(
      "changed",
    );

    const knownBytesChanged = structuredClone(known);
    const knownBytesEvent =
      knownBytesChanged.network.websocket_connections[0]!.events[1]!;
    if (knownBytesEvent.payload_bytes === null)
      throw new Error("Expected captured WebSocket byte count");
    knownBytesEvent.payload_bytes += 1;
    expect(compareNetwork(known, knownBytesChanged).status).toBe("changed");
  });
});

describe("web capture diff", () => {
  it("reports request membership changes when selected body shapes are unavailable", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const before = structuredClone(captured.value);
    const after = structuredClone(captured.value);
    const original = before.network.requests[0];
    if (original === undefined) throw new Error("Missing request fixture");
    after.network.requests.push({
      ...structuredClone(original),
      request_id: `${original.request_id}-added`,
      url: `${browser.allowedOrigin}/added`,
    });
    for (const inspection of [before, after]) {
      markSectionsComplete(inspection, [
        "network_requests",
        "websocket_connections",
        "websocket_frames",
      ]);
      for (const request of inspection.network.requests)
        request.body_shapes.status = "unavailable";
    }

    expect(compareNetwork(before, after)).toMatchObject({
      status: "changed",
      total_changes: 1,
      changes: [expect.objectContaining({ change: "added" })],
    });
  });

  it.each(["status", "mime_type"] as const)(
    "keeps an independently unavailable HTTP %s unknown",
    async (field) => {
      const browser = await startFakeCdpBrowser();
      browsers.push(browser);
      const captured = await new CdpBrowserProvider().inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!captured.ok) throw captured.error;
      const observed = structuredClone(captured.value);
      const request = observed.network.requests[0];
      if (request === undefined) throw new Error("Missing network request");
      request.status = 200;
      request.mime_type = "application/json";
      request.encoded_data_length = 100;
      markSectionsComplete(observed, [
        "network_requests",
        "websocket_connections",
        "websocket_frames",
        "json_body_shapes",
      ]);
      for (const item of observed.network.requests)
        item.body_shapes.status = "not_approved";
      expect(compareNetwork(observed, observed).status).toBe("unchanged");

      const partial = structuredClone(observed);
      partial.network.requests[0]![field] = null;
      for (const [left, right] of [
        [partial, observed],
        [observed, partial],
        [partial, partial],
      ] as const)
        expect(compareNetwork(left, right)).toMatchObject({
          status: "unknown",
          total_changes: 0,
          changes: [],
        });
    },
  );

  it("ignores transient request IDs and capture-approval state", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
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

describe("web capture redirect comparison", () => {
  it("ignores redirect event times but compares redirect semantics", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const before = structuredClone(captured.value);
    const beforeRequest = before.network.requests[0];
    if (beforeRequest === undefined) throw new Error("Missing network request");
    beforeRequest.redirects = [
      {
        url: `${browser.allowedOrigin}/prior`,
        response_url: `${browser.allowedOrigin}/prior`,
        method: "GET",
        resource_type: "Fetch",
        status: 302,
        mime_type: "text/plain",
        encoded_data_length: 12,
        request_timestamp: 1,
        redirect_event_timestamp: 2,
      },
    ];
    markSectionsComplete(before, [
      "network_requests",
      "websocket_connections",
      "websocket_frames",
    ]);

    const after = structuredClone(before);
    const afterRequest = after.network.requests[0];
    if (afterRequest === undefined) throw new Error("Missing network request");
    const hop = afterRequest.redirects?.[0];
    if (hop === undefined) throw new Error("Missing redirect hop");
    hop.request_timestamp = 10;
    hop.redirect_event_timestamp = 20;

    const compare = (inspection: typeof before) =>
      compareWebCaptures(
        compareWebCapturesInputSchema.parse({
          before: { inspection: before },
          after: { inspection },
        }),
      ).dimensions.network;
    expect(compare(after)).toMatchObject({
      status: "unchanged",
      total_changes: 0,
    });

    const changed = structuredClone(after);
    const changedHop = changed.network.requests[0]?.redirects?.[0];
    if (changedHop === undefined) throw new Error("Missing redirect hop");
    changedHop.status = 307;
    expect(compare(changed)).toMatchObject({
      status: "changed",
      changes: [expect.objectContaining({ change: "modified" })],
    });
  });

  it.each([
    ["status", 302],
    ["mime_type", "text/plain"],
    ["encoded_data_length", 12],
  ] as const)(
    "keeps unavailable redirect %s evidence unknown without suppressing known changes",
    async (field, knownValue) => {
      const browser = await startFakeCdpBrowser();
      browsers.push(browser);
      const captured = await new CdpBrowserProvider().inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!captured.ok) throw captured.error;
      const before = structuredClone(captured.value);
      const beforeRequest = before.network.requests[0];
      if (beforeRequest === undefined)
        throw new Error("Missing network request");
      beforeRequest.redirects = [
        {
          url: `${browser.allowedOrigin}/prior`,
          response_url: `${browser.allowedOrigin}/prior`,
          method: "GET",
          resource_type: "Fetch",
          status: 302,
          mime_type: "text/plain",
          encoded_data_length: 12,
          request_timestamp: 1,
          redirect_event_timestamp: 2,
        },
      ];
      markSectionsComplete(before, [
        "network_requests",
        "websocket_connections",
        "websocket_frames",
      ]);

      const compare = (left: typeof before, right: typeof before) =>
        compareWebCaptures(
          compareWebCapturesInputSchema.parse({
            before: { inspection: left },
            after: { inspection: right },
          }),
        ).dimensions.network;
      for (const missingOnRight of [false, true]) {
        const known = structuredClone(before);
        const missing = structuredClone(before);
        const knownHop = known.network.requests[0]?.redirects?.[0];
        const missingHop = missing.network.requests[0]?.redirects?.[0];
        if (knownHop === undefined || missingHop === undefined)
          throw new Error("Missing redirect fixture");
        Reflect.set(knownHop, field, knownValue);
        Reflect.set(missingHop, field, null);
        const result = missingOnRight
          ? compare(known, missing)
          : compare(missing, known);
        expect(result).toMatchObject({
          status: "unknown",
          total_changes: 0,
          reason: expect.stringContaining("redirect"),
        });
        expect(compare(missing, missing)).toMatchObject({
          status: "unknown",
          total_changes: 0,
          reason: expect.stringContaining("redirect"),
        });
      }

      const changed = structuredClone(before);
      const changedHop = changed.network.requests[0]?.redirects?.[0];
      if (changedHop === undefined) throw new Error("Missing redirect fixture");
      changedHop.status = 307;
      expect(compare(before, changed)).toMatchObject({
        status: "changed",
        changes: [expect.objectContaining({ change: "modified" })],
      });
    },
  );
});

describe("web capture diff incomplete inventories", () => {
  it("compares observed script facts without treating excluded map declarations as absent", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const known = structuredClone(captured.value);
    markSectionsComplete(known, ["scripts", "source_maps"]);
    known.completeness.excluded = known.completeness.excluded.filter(
      (item) => item.section !== "source_maps",
    );
    const script = known.scripts.items[0];
    if (script === undefined) throw new Error("Missing captured script");
    script.source_map_url = "https://cdn.example.test/app.js.map";
    script.cdp_hash = "a".repeat(64);
    script.length = 10;
    script.is_module = false;
    script.language = "JavaScript";
    const excluded = structuredClone(known);
    excluded.scripts.items[0]!.source_map_url = null;
    excluded.completeness.policy_filtered_sections.push("source_maps");
    excluded.completeness.excluded.push({
      section: "source_maps",
      reason: "disallowed_origin",
      count: 1,
    });
    const absent = structuredClone(known);
    absent.scripts.items[0]!.source_map_url = null;
    const changed = structuredClone(excluded);
    changed.scripts.items[0]!.cdp_hash = "b".repeat(64);
    const different = structuredClone(known);
    different.scripts.items[0]!.source_map_url =
      "https://cdn.example.test/other.map";
    const unavailableBody = structuredClone(known);
    unavailableBody.completeness.unavailable_sections.push("source_maps");
    const compare = (before: typeof known, after: typeof known) =>
      compareWebCaptures(
        compareWebCapturesInputSchema.parse({
          before: { inspection: before },
          after: { inspection: after },
        }),
      ).dimensions.scripts;
    for (const [left, right] of [
      [known, excluded],
      [excluded, known],
      [excluded, excluded],
      [absent, excluded],
    ] as const)
      expect(compare(left, right)).toMatchObject({
        status: "unknown",
        total_changes: 0,
      });
    const repeated = structuredClone(excluded);
    repeated.scripts.items.push(structuredClone(known.scripts.items[0]!));
    const completeRepeated = structuredClone(different);
    completeRepeated.scripts.items.push(
      structuredClone(different.scripts.items[0]!),
    );
    for (const [left, right] of [
      [repeated, completeRepeated],
      [completeRepeated, repeated],
    ] as const)
      expect(compare(left, right)).toMatchObject({
        status: "changed",
        total_changes: 1,
      });
    const linkedBefore = structuredClone(repeated);
    linkedBefore.scripts.items[0]!.cdp_hash = "b".repeat(64);
    const linkedAfter = structuredClone(linkedBefore);
    linkedAfter.scripts.items[1]!.source_map_url =
      "https://cdn.example.test/new.map";
    for (const [left, right] of [
      [linkedBefore, linkedAfter],
      [linkedAfter, linkedBefore],
    ] as const)
      expect(compare(left, right)).toMatchObject({
        status: "changed",
        total_changes: 1,
      });
    const ambiguous = structuredClone(linkedAfter);
    ambiguous.scripts.items[0]!.cdp_hash = "a".repeat(64);
    const ambiguousBefore = structuredClone(linkedBefore);
    ambiguousBefore.scripts.items[0]!.cdp_hash = "a".repeat(64);
    expect(compare(ambiguousBefore, ambiguous)).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
    const incompleteRepeated = structuredClone(repeated);
    incompleteRepeated.completeness.truncated_sections.push("scripts");
    expect(compare(incompleteRepeated, completeRepeated)).toMatchObject({
      status: "changed",
      total_changes: 1,
    });
    const possibleMatch = structuredClone(completeRepeated);
    possibleMatch.scripts.items[1]!.source_map_url = null;
    possibleMatch.completeness.policy_filtered_sections.push("source_maps");
    expect(compare(repeated, possibleMatch)).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
    for (const reason of [
      "unsupported_url",
      "invalid_protocol_value",
      "resource_budget_exhausted",
    ] as const) {
      const omission = structuredClone(absent);
      omission.completeness.excluded.push({
        section: "source_maps",
        reason,
        count: 1,
      });
      expect(compare(known, omission)).toMatchObject({
        status: "unknown",
        total_changes: 0,
      });
    }
    for (const [left, right] of [
      [known, known],
      [absent, absent],
      [known, unavailableBody],
    ] as const)
      expect(compare(left, right)).toMatchObject({
        status: "unchanged",
        total_changes: 0,
      });
    for (const [left, right] of [
      [known, different],
      [absent, known],
      [excluded, changed],
    ] as const)
      expect(compare(left, right)).toMatchObject({
        status: "changed",
        total_changes: 1,
      });
  });
});

describe("web capture diff partial script metadata", () => {
  it("proves a map change that a different hash or declaration cannot explain", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const known = structuredClone(captured.value);
    markSectionsComplete(known, ["scripts", "source_maps"]);
    known.completeness.excluded = known.completeness.excluded.filter(
      (item) => item.section !== "source_maps",
    );
    const script = known.scripts.items[0];
    if (script === undefined) throw new Error("Missing captured script");
    script.source_map_url = "https://cdn.example.test/app.js.map";
    script.cdp_hash = "a".repeat(64);
    script.length = 10;
    script.is_module = false;
    script.language = "JavaScript";
    const unknownDeclaration = structuredClone(script);
    unknownDeclaration.cdp_hash = "b".repeat(64);
    unknownDeclaration.source_map_url = null;
    const unknownHash = structuredClone(script);
    unknownHash.cdp_hash = null;
    unknownHash.source_map_url = "https://cdn.example.test/third.js.map";
    const before = structuredClone(known);
    before.scripts.items.push(unknownDeclaration, unknownHash);
    before.completeness.policy_filtered_sections.push("source_maps");
    const after = structuredClone(before);
    after.scripts.items[0]!.source_map_url =
      "https://cdn.example.test/new.js.map";
    const compare = (left: typeof known, right: typeof known) =>
      compareWebCaptures(
        compareWebCapturesInputSchema.parse({
          before: { inspection: left },
          after: { inspection: right },
        }),
      ).dimensions.scripts;
    expect(compare(before, structuredClone(before))).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
    expect(compare(before, after)).toMatchObject({
      status: "changed",
      total_changes: 1,
    });
  });
});

describe("web capture diff repeated source-map declarations", () => {
  it("keeps empty and absent declarations distinct during partial matching", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const template = captured.value.scripts.items[0];
    if (template === undefined) throw new Error("Missing captured script");
    const script = (hash: string, declaration: string | null) => ({
      ...structuredClone(template),
      cdp_hash: hash,
      source_map_url: declaration,
    });
    const partial = structuredClone(captured.value);
    const complete = structuredClone(captured.value);
    for (const value of [partial, complete])
      markSectionsComplete(value, ["scripts", "source_maps"]);
    partial.completeness.policy_filtered_sections.push("source_maps");
    partial.scripts.items = [
      script("hash-a", ""),
      script("hash-b", null),
      script("hash-a", null),
    ];
    complete.scripts.items = [
      script("hash-a", null),
      script("hash-a", ""),
      script("hash-b", "https://cdn.example.test/b.js.map"),
    ];
    for (const [before, after] of [
      [partial, complete],
      [complete, partial],
    ] as const)
      expect(
        compareWebCaptures(
          compareWebCapturesInputSchema.parse({
            before: { inspection: before },
            after: { inspection: after },
          }),
        ).dimensions.scripts,
      ).toMatchObject({ status: "unknown", total_changes: 0 });
  });

  it("proves differences that declaration counts cannot explain", async () => {
    const browser = await startFakeCdpBrowser();
    browsers.push(browser);
    const captured = await new CdpBrowserProvider().inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
      }),
    );
    if (!captured.ok) throw captured.error;
    const template = captured.value.scripts.items[0];
    if (template === undefined) throw new Error("Missing captured script");
    const copies = (count: number, sourceMapUrl: string | null) =>
      Array.from({ length: count }, () => {
        const script = structuredClone(template);
        script.source_map_url = sourceMapUrl;
        return script;
      });
    const inspection = (
      items: typeof captured.value.scripts.items,
      omitDeclarations: boolean,
    ) => {
      const value = structuredClone(captured.value);
      markSectionsComplete(value, ["scripts", "source_maps"]);
      value.scripts.items = items;
      if (omitDeclarations)
        value.completeness.policy_filtered_sections.push("source_maps");
      return value;
    };
    const compare = (
      left: typeof captured.value,
      right: typeof captured.value,
    ) =>
      compareWebCaptures(
        compareWebCapturesInputSchema.parse({
          before: { inspection: left },
          after: { inspection: right },
        }),
      ).dimensions.scripts;
    const map = (name: string) => `https://cdn.example.test/${name}.js.map`;
    const nineX = inspection(
      [...copies(9, map("x")), ...copies(1, null)],
      true,
    );
    const tenY = inspection(copies(10, map("y")), false);
    const sevenA = inspection(
      [...copies(7, map("a")), ...copies(1, map("b")), ...copies(1, null)],
      true,
    );
    const twelveA = inspection(copies(12, map("a")), false);

    expect(compare(nineX, structuredClone(nineX))).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
    expect(compare(nineX, tenY)).toMatchObject({
      status: "changed",
      total_changes: 1,
    });
    expect(compare(sevenA, twelveA)).toMatchObject({
      status: "changed",
      total_changes: 1,
    });
    const repeated = inspection(
      [...copies(2_000, map("a")), ...copies(1, null)],
      true,
    );
    expect(compare(repeated, structuredClone(repeated))).toMatchObject({
      status: "unknown",
      total_changes: 0,
    });
  });
});

describe("web capture diff script inventory coverage", () => {
  it.each(["truncated_sections", "unavailable_sections"] as const)(
    "does not infer script additions or removals from %s",
    async (section) => {
      const browser = await startFakeCdpBrowser();
      browsers.push(browser);
      const captured = await new CdpBrowserProvider().inspectPage(
        inspectWebPageInputSchema.parse({
          cdp_endpoint: browser.endpoint,
          allowed_origins: [browser.allowedOrigin],
          target_id: "allowed-page",
          observation_ms: 0,
        }),
      );
      if (!captured.ok) throw captured.error;
      const complete = structuredClone(captured.value);
      markSectionsComplete(complete, ["scripts"]);
      expect(complete.scripts.items).toHaveLength(1);
      const incomplete = structuredClone(complete);
      incomplete.scripts.items = [];
      incomplete.completeness[section].push("scripts");
      const compare = (before: typeof complete, after: typeof complete) =>
        compareWebCaptures(
          compareWebCapturesInputSchema.parse({
            before: { inspection: before },
            after: { inspection: after },
          }),
        ).dimensions.scripts;

      expect(compare(complete, incomplete)).toMatchObject({
        status: "unknown",
        total_changes: 0,
        changes: [],
      });
      expect(compare(incomplete, complete)).toMatchObject({
        status: "unknown",
        total_changes: 0,
        changes: [],
      });
      markSectionsComplete(incomplete, ["scripts"]);
      expect(compare(complete, incomplete).changes).toEqual([
        expect.objectContaining({ change: "removed" }),
      ]);
      expect(compare(incomplete, complete).changes).toEqual([
        expect.objectContaining({ change: "added" }),
      ]);
      const modified = structuredClone(complete);
      modified.completeness[section].push("scripts");
      const script = modified.scripts.items[0];
      if (script === undefined) throw new Error("Missing captured script");
      script.url = `${script.url}?revision=2`;
      expect(compare(complete, modified).changes).toEqual([
        expect.objectContaining({ change: "added" }),
      ]);
    },
  );
});

it("compares retained accessibility and storage facts across incomplete captures", async () => {
  const browser = await startFakeCdpBrowser({ extraCollections: true });
  browsers.push(browser);
  const provider = new CdpBrowserProvider();
  const inspect = async (selection: {
    include_accessibility_text: boolean;
    include_storage_keys?: boolean;
    include_storage_fingerprints?: boolean;
  }) => {
    const result = await provider.inspectPage(
      inspectWebPageInputSchema.parse({
        cdp_endpoint: browser.endpoint,
        allowed_origins: [browser.allowedOrigin],
        target_id: "allowed-page",
        observation_ms: 0,
        ...selection,
      }),
    );
    if (!result.ok) throw result.error;
    return result.value;
  };
  const observed = await inspect({
    include_accessibility_text: true,
    include_storage_keys: true,
    include_storage_fingerprints: true,
  });
  const withheld = await inspect({ include_accessibility_text: false });
  expect(withheld.completeness.policy_filtered_sections).toContain(
    "accessibility",
  );
  expect(withheld.completeness.excluded).toContainEqual(
    expect.objectContaining({
      section: "accessibility",
      reason: "not_approved",
    }),
  );

  const compare = (after: WebPageInspection) =>
    compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: observed },
        after: { inspection: after },
      }),
    ).dimensions;
  const identical = compare(observed);
  for (const dimension of [identical.accessibility, identical.storage])
    expect(dimension).toMatchObject({
      status: "unchanged",
      total_changes: 0,
      changes: [],
    });

  const edit = (
    capture: WebPageInspection,
    change: (copy: WebPageInspection) => void,
  ) => {
    const copy = structuredClone(capture);
    change(copy);
    return copy;
  };
  const changedTree = {
    status: "changed",
    total_changes: 1,
    changes: [{ identity: "accessibility_tree", change: "modified" }],
  };
  const unknown = { status: "unknown", total_changes: 0, changes: [] };
  for (const patch of [{ role: "menuitem" }, { name: "Send report" }]) {
    const after = edit(observed, ({ accessibility }) => {
      const node = accessibility.nodes[0];
      if (node === undefined) throw new Error("Expected accessibility node");
      Object.assign(node, patch);
    });
    expect(compare(after).accessibility).toMatchObject(changedTree);
  }
  const stateChanged = edit(observed, ({ accessibility }) => {
    const state = accessibility.nodes[0]?.states.find(
      ({ name }) => name === "disabled",
    );
    if (state === undefined) throw new Error("Expected the disabled state");
    state.value = true;
  });
  expect(compare(stateChanged).accessibility).toMatchObject(changedTree);

  const reparent = ({ accessibility }: WebPageInspection) => {
    const child = accessibility.nodes[1];
    if (child === undefined) throw new Error("Expected accessibility child");
    child.parent_id = null;
  };
  expect(compare(edit(observed, reparent)).accessibility).toMatchObject(
    changedTree,
  );
  expect(compare(withheld).accessibility).toMatchObject(unknown);
  expect(compare(edit(withheld, reparent)).accessibility).toMatchObject(
    changedTree,
  );
  const withoutRole = edit(observed, ({ accessibility }) => {
    const node = accessibility.nodes[0];
    if (node === undefined)
      throw new Error("Expected a node with an observed role");
    node.role = null;
  });
  expect(compare(withoutRole).accessibility).toMatchObject(unknown);
  expect(compare(edit(withoutRole, reparent)).accessibility).toMatchObject(
    changedTree,
  );

  const treeChanged = edit(observed, reparent);
  const partial = edit(treeChanged, ({ completeness }) => {
    completeness.truncated_sections.push("accessibility");
  });
  const missingNode = edit(treeChanged, ({ accessibility }) => {
    accessibility.total_nodes++;
  });
  expect(compare(partial).accessibility).toMatchObject(unknown);
  expect(compare(missingNode).accessibility).toMatchObject(unknown);

  const keyAdded = edit(observed, ({ storage }) => {
    storage.local_storage_keys.push("new-key");
  });
  expect(compare(keyAdded).storage.changes).toEqual([
    { identity: "storage:local_storage:new-key", change: "added" },
  ]);
  const fingerprintIndex = observed.storage.content_fingerprints.findIndex(
    ({ complete, value_sha256 }) => complete && value_sha256 !== null,
  );
  const changedFingerprint = edit(observed, ({ storage }) => {
    const fingerprint = storage.content_fingerprints[fingerprintIndex];
    if (fingerprint === undefined)
      throw new Error("Expected a complete storage fingerprint");
    fingerprint.value_sha256 = "f".repeat(64);
  });
  const contentChange = {
    status: "changed",
    total_changes: 1,
    changes: [expect.objectContaining({ change: "modified" })],
  };
  expect(compare(changedFingerprint).storage).toMatchObject(contentChange);
  const omitInventoryProof = ({ storage }: WebPageInspection) => {
    storage.fingerprints_complete = false;
  };
  expect(
    compare(edit(changedFingerprint, omitInventoryProof)).storage,
  ).toMatchObject(contentChange);
  expect(compare(edit(observed, omitInventoryProof)).storage).toMatchObject(
    unknown,
  );
  const unverifiedValue = edit(changedFingerprint, (capture) => {
    omitInventoryProof(capture);
    const fingerprint = capture.storage.content_fingerprints[fingerprintIndex];
    if (fingerprint === undefined)
      throw new Error("Expected a retained storage fingerprint");
    fingerprint.complete = false;
  });
  expect(compare(unverifiedValue).storage).toMatchObject(unknown);
});

it("refuses an IndexedDB schema fingerprint without its projection version", async () => {
  const browser = await startFakeCdpBrowser();
  browsers.push(browser);
  const current = await inspectStorage(browser, true);
  const index = current.storage.content_fingerprints.findIndex(
    ({ scope }) => scope === "indexed_db_schema",
  );
  const schema = current.storage.content_fingerprints[index];
  if (schema?.scope !== "indexed_db_schema")
    throw new Error("Expected an IndexedDB schema fingerprint");
  expect(schema.projection_version).toBe(2);
  const { projection_version: _version, ...withoutVersion } = schema;
  const unmarked = structuredClone(current);
  (unmarked.storage.content_fingerprints as unknown[])[index] = withoutVersion;
  expect(
    webPageInspectionSchema.safeParse(unmarked).error?.issues,
  ).toMatchObject([
    {
      path: ["storage", "content_fingerprints", index, "projection_version"],
    },
  ]);
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

const compareNetwork = (before: WebPageInspection, after: WebPageInspection) =>
  compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: before },
      after: { inspection: after },
    }),
  ).dimensions.network;
