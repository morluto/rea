import { afterEach, describe, expect, it } from "vitest";

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { passiveNetworkCapture } from "../../fixtures/passiveNetworkCapture.js";

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

    for (const patch of [
      { direction: "received" },
      { opcode: 2 },
      { payload_shape: { format: "binary", json_shape: null } },
    ] as const) {
      const changed = structuredClone(before);
      const frame = changed.network.websocket_connections[0]?.events[0];
      if (frame === undefined)
        throw new Error("Expected a retained WebSocket frame");
      Object.assign(frame, patch);
      expect(compareNetwork(before, changed)).toMatchObject({
        status: "changed",
        changes: [expect.objectContaining({ change: "modified" })],
      });
    }

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

it("preserves WebSocket stream correlation and compares only shared payload evidence", async () => {
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
  const known = captured.value;
  markSectionsComplete(known, [
    "network_requests",
    "websocket_connections",
    "websocket_frames",
    "websocket_shapes",
  ]);
  const baseConnection = known.network.websocket_connections[0];
  if (baseConnection === undefined)
    throw new Error("Expected a WebSocket connection");

  const shape = (root_type: "string" | "number") => ({
    format: "json" as const,
    json_shape: {
      root_type,
      node_count: 1,
      max_depth_observed: 0,
      properties: [],
    },
  });
  const stringShape = shape("string");
  const numberShape = shape("number");
  const streams = (
    ...rows: readonly (readonly [typeof stringShape, typeof stringShape])[]
  ) => {
    const capture = structuredClone(known);
    capture.network.websocket_connections = rows.map(
      ([first, second], index) => {
        const stream = structuredClone(baseConnection);
        stream.request_id = `socket-${String(index)}`;
        const [sent, received] = stream.events;
        if (sent === undefined || received === undefined)
          throw new Error("Expected two retained WebSocket frames");
        sent.payload_shape = first;
        received.payload_shape = second;
        return stream;
      },
    );
    return capture;
  };
  const editFrame = (
    capture: WebPageInspection,
    frameIndex: number,
    patch: Partial<(typeof baseConnection.events)[number]>,
    connectionIndex = 0,
  ) => {
    const copy = structuredClone(capture);
    const frame =
      copy.network.websocket_connections[connectionIndex]?.events[frameIndex];
    if (frame === undefined)
      throw new Error("Expected a retained WebSocket frame");
    Object.assign(frame, patch);
    return copy;
  };

  const correlated = streams(
    [stringShape, stringShape],
    [numberShape, numberShape],
  );
  expect(
    compareNetwork(
      correlated,
      streams([numberShape, numberShape], [stringShape, stringShape]),
    ).status,
  ).toBe("unchanged");
  // Both positions have the same marginal shapes, but the pairing within each connection changed.
  expect(
    compareNetwork(
      correlated,
      streams([stringShape, numberShape], [numberShape, stringShape]),
    ).status,
  ).toBe("changed");
  const unknown = { status: "unknown", total_changes: 0, changes: [] };
  const partial = editFrame(correlated, 1, { payload_shape: null });
  expect(
    compareNetwork(
      partial,
      editFrame(partial, 1, { payload_shape: stringShape }, 1),
    ),
  ).toMatchObject(unknown);
  expect(
    compareNetwork(
      partial,
      editFrame(partial, 0, { payload_shape: numberShape }),
    ).status,
  ).toBe("changed");

  const unavailable = structuredClone(known);
  unavailable.completeness.unavailable_sections.push("websocket_shapes");
  for (const { events } of unavailable.network.websocket_connections)
    for (const frame of events) frame.payload_shape = null;
  expect(compareNetwork(unavailable, unavailable)).toMatchObject(unknown);
  expect(
    compareNetwork(unavailable, editFrame(known, 0, { opcode: 2 })).status,
  ).toBe("changed");

  const truncated = editFrame(known, 0, { payload_shape: null });
  truncated.completeness.truncated_sections.push("websocket_shapes");
  const unknownBytes = editFrame(known, 1, { payload_bytes: null });
  for (const limited of [unavailable, truncated, unknownBytes]) {
    expect(compareNetwork(known, limited)).toMatchObject(unknown);
    expect(compareNetwork(limited, known)).toMatchObject(unknown);
  }
  expect(
    compareNetwork(
      unknownBytes,
      editFrame(unknownBytes, 1, { direction: "sent" }),
    ).status,
  ).toBe("changed");
  const size = baseConnection.events[1]?.payload_bytes;
  if (size === null || size === undefined)
    throw new Error("Expected a captured WebSocket byte count");
  expect(
    compareNetwork(known, editFrame(known, 1, { payload_bytes: size + 1 }))
      .status,
  ).toBe("changed");
});

it("compares HTTP and script evidence independently of local request IDs and approval wording", async () => {
  const browser = await startFakeCdpBrowser();
  browsers.push(browser);
  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 0,
    }),
  );
  if (!result.ok) throw result.error;
  const before = result.value;
  const request = before.network.requests[0];
  if (request === undefined)
    throw new Error("Expected a captured HTTP request");
  Object.assign(request, {
    status: 200,
    mime_type: "application/json",
    encoded_data_length: 100,
  });
  before.workers = [];
  markSectionsComplete(before, [
    "network_requests",
    "network_initiators",
    "websocket_connections",
    "websocket_frames",
    "scripts",
    "workers",
    "metadata",
  ]);
  const after = structuredClone(before);
  const response = after.metadata.responses[0];
  const script = after.scripts.items[0];
  if (response === undefined || script?.source.included !== false)
    throw new Error(
      "Expected captured response metadata and a withheld script",
    );
  after.network.requests[0]!.request_id = "changed-cdp-id";
  response.request_id = "changed-cdp-id";
  script.source.reason = "different approval explanation";
  const dimensions = compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: before },
      after: { inspection: after },
    }),
  ).dimensions;
  for (const dimension of [
    dimensions.network,
    dimensions.metadata,
    dimensions.scripts,
  ])
    expect(dimension).toMatchObject({
      status: "unchanged",
      total_changes: 0,
      changes: [],
    });
});

const compareScripts = (before: WebPageInspection, after: WebPageInspection) =>
  compareWebCaptures(
    compareWebCapturesInputSchema.parse({
      before: { inspection: before },
      after: { inspection: after },
    }),
  ).dimensions.scripts;

const expectScriptMembershipCoverage = (complete: WebPageInspection): void => {
  const absent = structuredClone(complete);
  absent.scripts = { total: 0, items: [] };
  const added = [expect.objectContaining({ change: "added" })];
  const removed = [expect.objectContaining({ change: "removed" })];
  expect(compareScripts(complete, absent).changes).toEqual(removed);
  expect(compareScripts(absent, complete).changes).toEqual(added);

  const revise = structuredClone(complete);
  const script = revise.scripts.items[0];
  if (script === undefined) throw new Error("Expected a captured script");
  script.url = `${script.url}?revision=2`;
  const drop = (
    inspection: WebPageInspection,
    kind: "scripts" | "console_events",
  ) => {
    const completeness = inspection.completeness;
    completeness.dropped_events[kind]++;
    completeness.dropped_events.total++;
    completeness.status = "truncated";
    if (!completeness.conditions.includes("truncated"))
      completeness.conditions = [
        ...completeness.conditions.filter(
          (condition) => condition !== "complete_within_window",
        ),
        "truncated",
      ];
  };
  const unrelatedDrop = structuredClone(absent);
  drop(unrelatedDrop, "console_events");
  expect(compareScripts(complete, unrelatedDrop).changes).toEqual(removed);
  expect(compareScripts(unrelatedDrop, complete).changes).toEqual(added);

  const emptyUnknown = { status: "unknown", total_changes: 0, changes: [] };
  for (const limit of [
    ({ completeness }: WebPageInspection) => {
      completeness.truncated_sections.push("scripts");
    },
    ({ completeness }: WebPageInspection) => {
      completeness.unavailable_sections.push("scripts");
    },
    (inspection: WebPageInspection) => {
      drop(inspection, "scripts");
    },
  ]) {
    const incomplete = structuredClone(absent);
    incomplete.scripts.total = complete.scripts.total;
    limit(incomplete);
    expect(compareScripts(complete, incomplete)).toMatchObject(emptyUnknown);
    expect(compareScripts(incomplete, complete)).toMatchObject(emptyUnknown);

    const retained = structuredClone(revise);
    limit(retained);
    expect(compareScripts(complete, retained).changes).toEqual(added);
    expect(compareScripts(retained, complete).changes).toEqual(removed);
  }
};

it("compares observed scripts without assuming inventory or declaration absence", async () => {
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
  known.workers = [];
  markSectionsComplete(known, ["scripts", "source_maps", "workers"]);
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
  const absentWithUnavailableBody = structuredClone(absent);
  absentWithUnavailableBody.completeness.unavailable_sections.push(
    "source_maps",
  );
  const zeroOmissions = structuredClone(absent);
  zeroOmissions.completeness.excluded.push({
    section: "source_maps",
    reason: "unsupported_url",
    count: 0,
  });
  expectScriptMembershipCoverage(known);
  const unknown = { status: "unknown", total_changes: 0, changes: [] };
  const changedScript = { status: "changed", total_changes: 1 };
  const unchanged = { status: "unchanged", total_changes: 0, changes: [] };
  for (const [left, right] of [
    [known, excluded],
    [excluded, known],
    [excluded, excluded],
    [absent, excluded],
  ] as const)
    expect(compareScripts(left, right)).toMatchObject(unknown);
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
    expect(compareScripts(left, right)).toMatchObject(changedScript);
  const linkedBefore = structuredClone(repeated);
  linkedBefore.scripts.items[0]!.cdp_hash = "b".repeat(64);
  const linkedAfter = structuredClone(linkedBefore);
  linkedAfter.scripts.items[1]!.source_map_url =
    "https://cdn.example.test/new.map";
  for (const [left, right] of [
    [linkedBefore, linkedAfter],
    [linkedAfter, linkedBefore],
  ] as const)
    expect(compareScripts(left, right)).toMatchObject(changedScript);
  const ambiguous = structuredClone(linkedAfter);
  ambiguous.scripts.items[0]!.cdp_hash = "a".repeat(64);
  const ambiguousBefore = structuredClone(linkedBefore);
  ambiguousBefore.scripts.items[0]!.cdp_hash = "a".repeat(64);
  expect(compareScripts(ambiguousBefore, ambiguous)).toMatchObject(unknown);
  const incompleteRepeated = structuredClone(repeated);
  incompleteRepeated.completeness.truncated_sections.push("scripts");
  expect(compareScripts(incompleteRepeated, completeRepeated)).toMatchObject(
    changedScript,
  );
  const possibleMatch = structuredClone(completeRepeated);
  possibleMatch.scripts.items[1]!.source_map_url = null;
  possibleMatch.completeness.policy_filtered_sections.push("source_maps");
  expect(compareScripts(repeated, possibleMatch)).toMatchObject(unknown);
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
    expect(compareScripts(known, omission)).toMatchObject(unknown);
  }
  for (const [left, right] of [
    [known, known],
    [absent, absent],
    [known, unavailableBody],
  ] as const)
    expect(compareScripts(left, right)).toMatchObject(unchanged);
  for (const [left, right] of [
    [known, different],
    [absent, known],
    [known, absentWithUnavailableBody],
    [known, zeroOmissions],
    [excluded, changed],
  ] as const)
    expect(compareScripts(left, right)).toMatchObject(changedScript);
});

it("compares partial source-map declarations against compatible script occurrences", async () => {
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
  const baseline = captured.value;
  const template = baseline.scripts.items[0];
  if (template === undefined) throw new Error("Expected a captured script");
  markSectionsComplete(baseline, ["scripts", "source_maps"]);
  baseline.completeness.excluded = baseline.completeness.excluded.filter(
    ({ section }) => section !== "source_maps",
  );
  const script = (cdp_hash: string | null, source_map_url: string | null) => ({
    ...template,
    cdp_hash,
    source_map_url,
    length: 10,
    is_module: false,
    language: "JavaScript",
  });
  const capture = (
    items: typeof baseline.scripts.items,
    omitDeclarations = false,
  ) => {
    const inspection = structuredClone(baseline);
    inspection.scripts.items = items;
    if (omitDeclarations)
      inspection.completeness.policy_filtered_sections.push("source_maps");
    return inspection;
  };
  const compare = (left: WebPageInspection, right: WebPageInspection) =>
    compareWebCaptures(
      compareWebCapturesInputSchema.parse({
        before: { inspection: left },
        after: { inspection: right },
      }),
    ).dimensions.scripts;
  const unknown = { status: "unknown", total_changes: 0, changes: [] };
  const modified = {
    status: "changed",
    total_changes: 1,
    changes: [expect.objectContaining({ change: "modified" })],
  };
  const map = (name: string) => `https://cdn.example.test/${name}.js.map`;
  const hashA = "hash-a";
  const hashB = "hash-b";
  const hashC = "hash-c";

  const partial = capture(
    [
      script(hashA, map("app")),
      script(hashB, null),
      script(null, map("third")),
    ],
    true,
  );
  const changedMap = capture(
    [
      script(hashA, map("new")),
      script(hashB, null),
      script(null, map("third")),
    ],
    true,
  );
  expect(compare(partial, partial)).toMatchObject(unknown);
  expect(compare(partial, changedMap)).toMatchObject(modified);

  const omitted = capture(
    [script(hashA, ""), script(hashB, null), script(hashA, null)],
    true,
  );
  const explicit = capture([
    script(hashA, null),
    script(hashA, ""),
    script(hashB, map("b")),
  ]);
  expect(compare(omitted, explicit)).toMatchObject(unknown);
  expect(compare(explicit, omitted)).toMatchObject(unknown);
  const absent = capture([
    script(hashA, null),
    script(hashA, null),
    script(hashB, map("b")),
  ]);
  expect(compare(omitted, absent)).toMatchObject(modified);

  // The flexible declaration can use either slot. The second declaration must use the matching hash.
  const needs = capture([
    script(null, map("flexible")),
    script(hashA, map("constrained")),
  ]);
  const slots = [script(hashA, null), script(hashB, null)];
  expect(compare(needs, capture(slots, true))).toMatchObject(unknown);
  expect(compare(needs, capture(slots.toReversed(), true))).toMatchObject(
    unknown,
  );
  const incompatible = capture([
    script(null, map("flexible")),
    script(hashC, map("constrained")),
  ]);
  expect(compare(incompatible, capture(slots, true))).toMatchObject(modified);

  const copies = (count: number, declaration: string) =>
    Array.from({ length: count }, () => script(hashA, declaration));
  const nineX = capture([...copies(9, map("x")), script(hashA, null)], true);
  expect(compare(nineX, nineX)).toMatchObject(unknown);
  expect(compare(nineX, capture(copies(10, map("y"))))).toMatchObject(modified);
  const sevenA = capture(
    [...copies(7, map("a")), script(hashA, map("b")), script(hashA, null)],
    true,
  );
  expect(compare(sevenA, capture(copies(12, map("a"))))).toMatchObject(
    modified,
  );
  const repeated = capture(
    [...copies(2_000, map("a")), script(hashA, null)],
    true,
  );
  expect(compare(repeated, repeated)).toMatchObject(unknown);
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

describe("HTTP response source comparison", () => {
  cliTest(
    "compares mutually known response sources without inventing changes for historical or partial captures",
    async ({ cli }) => {
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
      const before = captured.value;
      markSectionsComplete(before, ["network_requests"]);
      before.network.requests[0]!.response_source = {
        service_worker: false,
        disk_cache: false,
        service_worker_response_source: "network",
      };
      for (const field of [
        "service_worker",
        "disk_cache",
        "service_worker_response_source",
      ] as const) {
        const after = structuredClone(before);
        const source = after.network.requests[0]!.response_source!;
        if (field === "service_worker_response_source")
          source[field] = "cache-storage";
        else source[field] = true;
        expect(compareNetwork(before, after)).toMatchObject({
          status: "changed",
          changes: [expect.objectContaining({ change: "modified" })],
        });
        source[field] = null;
        expect(compareNetwork(before, after).total_changes).toBe(0);
        expect(compareNetwork(after, before).total_changes).toBe(0);
      }
      const legacy = structuredClone(before);
      delete legacy.network.requests[0]!.response_source;
      expect(compareNetwork(before, legacy).total_changes).toBe(0);
      expect(compareNetwork(legacy, before).total_changes).toBe(0);
      const mixed = structuredClone(before);
      mixed.network.requests[0]!.response_source = {
        service_worker: true,
        disk_cache: null,
        service_worker_response_source: null,
      };
      expect(compareNetwork(before, mixed).status).toBe("changed");
      const root = await createTestTempDirectory("rea-response-source-diff-");
      const beforePath = join(root, "before.json");
      const afterPath = join(root, "after.json");
      await writeFile(beforePath, JSON.stringify({ inspection: before }));
      await writeFile(afterPath, JSON.stringify({ inspection: mixed }));
      const evidence = parseEvidence(
        (
          await cli.run({
            arguments: [
              "compare-web-captures",
              beforePath,
              afterPath,
              "--json",
            ],
          })
        ).json,
      );
      expect(evidence.normalized_result).toMatchObject({
        dimensions: {
          network: {
            status: "changed",
            changes: [expect.objectContaining({ change: "modified" })],
          },
        },
      });
      const { client, call } = await connectLocalToolsMcp();
      const response = await call("compare_web_captures", {
        before: { inspection: before },
        after: { inspection: mixed },
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(response.structuredContent).toEqual(evidence);
      await client.ping();
      const repeated = passiveNetworkCapture(["/a", "/a"]);
      const first = repeated.network.requests[0]!;
      first.response_source = {
        service_worker: false,
        disk_cache: false,
        service_worker_response_source: "network",
      };
      const surviving = structuredClone(first);
      surviving.request_id = "surviving-sample";
      surviving.response_source!.service_worker = true;
      repeated.network.requests = [first, surviving];
      const reduced = structuredClone(repeated);
      reduced.network.requests = [surviving];
      for (const limited of ["neither", "before", "after"]) {
        repeated.completeness.dropped_events.network_requests =
          limited === "before" ? 1 : 0;
        reduced.completeness.dropped_events.network_requests =
          limited === "after" ? 1 : 0;
        await writeFile(beforePath, JSON.stringify({ inspection: repeated }));
        await writeFile(afterPath, JSON.stringify({ inspection: reduced }));
        const compared = parseEvidence(
          (
            await cli.run({
              arguments: [
                "compare-web-captures",
                beforePath,
                afterPath,
                "--json",
              ],
            })
          ).json,
        );
        expect(compared.normalized_result).toMatchObject({
          dimensions: {
            network: {
              status: limited === "after" ? "unknown" : "changed",
              total_changes: limited === "after" ? 0 : 1,
            },
          },
        });
        const result = await call("compare_web_captures", {
          before: { inspection: repeated },
          after: { inspection: reduced },
        });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(result.structuredContent).toEqual(compared);
      }
    },
  );
});
