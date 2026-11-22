import { describe, expect, it } from "vitest";

import { CdpCaptureEvents } from "../../../src/browser/CdpCaptureEvents.js";
import { CdpTargetDocument } from "../../../src/browser/CdpTargetDocument.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { CDP_CAPTURE_SCRIPT_METADATA_LIMITS } from "../../../src/browser/CdpCaptureEventTypes.js";
import { receiveCdpEvent } from "../../../src/browser/CdpConnection.js";

describe("CDP script metadata admission", () => {
  const origin = "https://app.example";
  const emit = (
    events: CdpCaptureEvents,
    scriptId: string,
    sourceMapURL?: unknown,
  ) =>
    events.ingest(
      receiveCdpEvent({
        method: "Debugger.scriptParsed",
        params: { scriptId, url: `${origin}/app.js`, sourceMapURL },
      }),
    );
  const mapPath = (size: number) => `/maps/${"x".repeat(size)}.map`;
  const mebibyte = 1024 * 1024;
  const resourceExclusions = (events: CdpCaptureEvents) =>
    events.completeness
      .snapshot()
      .excluded.filter(({ reason }) => reason === "resource_budget_exhausted");

  it("retains an invalid source-map declaration as unknown", () => {
    const events = captureEvents();
    events.beginAuthorizedFrame(new CdpTargetDocument({ frameId: "frame-1" }));
    for (const [scriptId, sourceMapURL] of [
      ["bad", null],
      ["absent", undefined],
      ["empty", ""],
    ] as const) {
      emit(events, scriptId, sourceMapURL);
      expect(events.scripts.get(scriptId)?.sourceMapUrl).toBeNull();
    }
    expect(events.completeness.snapshot().excluded).toContainEqual({
      section: "source_maps",
      reason: "invalid_protocol_value",
      count: 1,
    });
  });

  it("reclaims replaced map bytes and starts each document with a fresh budget", () => {
    const events = captureEvents();
    events.beginAuthorizedFrame(new CdpTargetDocument({ frameId: "frame-1" }));
    const expectMap = (id: string, payloadBytes: number) => {
      const url = events.scripts.get(id)?.sourceMapUrl;
      expect(url?.length).toBe(`${origin}/maps/.map`.length + payloadBytes);
      expect(url?.endsWith(".map")).toBe(true);
    };

    emit(events, "same-id", mapPath(3 * mebibyte));
    emit(events, "same-id", mapPath(2 * mebibyte));
    emit(events, "next-id", mapPath(mebibyte));
    expectMap("same-id", 2 * mebibyte);
    expectMap("next-id", mebibyte);
    expect(events.retainedScriptMetadataBytes).toBeLessThanOrEqual(
      CDP_CAPTURE_SCRIPT_METADATA_LIMITS.retainedBytes,
    );
    emit(events, "normalized-url", `${"./".repeat(1_200_000)}map.js.map`);
    expect(events.scripts.get("normalized-url")?.sourceMapUrl).toBe(
      `${origin}/map.js.map`,
    );

    events.beginAuthorizedFrame(new CdpTargetDocument({ frameId: "frame-2" }));
    emit(events, "new-document", mapPath(5 * mebibyte));
    expect(events.scripts.get("new-document")?.sourceMapUrl).toBeNull();
    emit(events, "new-document", mapPath(mebibyte));
    expectMap("new-document", mebibyte);
    events.recordScriptMetadataBudgetExclusions();
    expect(resourceExclusions(events)).toEqual([]);

    events.beginAuthorizedFrame(new CdpTargetDocument({ frameId: "frame-3" }));
    emit(events, "new-document", mapPath(3 * mebibyte));
    expectMap("new-document", 3 * mebibyte);
    emit(events, "map-overflow", mapPath(2 * mebibyte));
    expect(events.scripts.get("map-overflow")?.sourceMapUrl).toBeNull();
    events.recordScriptMetadataBudgetExclusions();
    expect(resourceExclusions(events)).toEqual([
      { section: "source_maps", reason: "resource_budget_exhausted", count: 1 },
    ]);
  });

  it("rejects oversized metadata and excess records at independent boundaries", () => {
    const events = captureEvents();
    events.beginAuthorizedFrame(new CdpTargetDocument({ frameId: "frame-1" }));
    const { retainedBytes, scripts } = CDP_CAPTURE_SCRIPT_METADATA_LIMITS;
    const oversized = "x".repeat(retainedBytes + 1);
    emit(events, oversized);
    expect(events.scripts.has(oversized)).toBe(false);

    for (let index = 0; index < scripts; index += 1)
      emit(events, `script-${String(index)}`);
    expect(events.scripts.size).toBe(scripts);
    expect(events.scripts.has(`script-${String(scripts - 1)}`)).toBe(true);
    expect(events.retainedScriptMetadataBytes).toBeLessThan(retainedBytes);
    emit(events, "record-overflow", "/maps/overflow.map");
    expect(events.scripts.has("record-overflow")).toBe(false);
    expect(events.scriptMetadataBudgetOmissionsById.size).toBe(0);

    events.recordScriptMetadataBudgetExclusions();
    expect(resourceExclusions(events)).toEqual([
      { section: "scripts", reason: "resource_budget_exhausted", count: 2 },
      { section: "source_maps", reason: "resource_budget_exhausted", count: 1 },
    ]);
  });
});

const captureEvents = (): CdpCaptureEvents =>
  new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: ["https://app.example"],
      target_id: "page",
      observation_ms: 0,
    }),
    new Set(["https://app.example"]),
  );

it("retains script identity and classifies each frame claim independently", () => {
  const events = captureEvents();
  const frameId = "frame-1";
  const allowedFrames = new Set([frameId]);
  events.beginAuthorizedFrame(new CdpTargetDocument({ frameId }));
  events.ingest(
    receiveCdpEvent({
      method: "Runtime.executionContextCreated",
      params: { context: { id: 7, auxData: { frameId } } },
    }),
  );

  let invalidClaims = 0;
  for (const [scriptId, auxiliary, expectedFrame] of [
    ["no-auxiliary-data", undefined, frameId],
    ["omitted-frame", { isDefault: true }, frameId],
    ["matching-frame", { frameId }, frameId],
    ["conflicting-frame", { frameId: "other-frame" }, null],
    ["empty-frame", { frameId: "" }, null],
    ["null-frame", { frameId: null }, null],
    ["numeric-frame", { frameId: 7 }, null],
    ["malformed-auxiliary-data", null, null],
  ] as const) {
    events.ingest(
      receiveCdpEvent({
        method: "Debugger.scriptParsed",
        params: {
          scriptId,
          url: `https://app.example/${scriptId}.js`,
          executionContextId: 7,
          ...(auxiliary === undefined
            ? {}
            : { executionContextAuxData: auxiliary }),
        },
      }),
    );
    const script = events.scripts.get(scriptId);
    if (script === undefined) throw new Error(`Missing script ${scriptId}`);
    expect(script.frameId, scriptId).toBe(expectedFrame);
    expect(events.frameForScript(script, allowedFrames), scriptId).toBe(
      expectedFrame,
    );
    invalidClaims += expectedFrame === null ? 1 : 0;
    expect(
      events.completeness
        .snapshot()
        .excluded.filter(({ section }) => section === "scripts"),
      scriptId,
    ).toEqual(
      invalidClaims === 0
        ? []
        : [
            {
              section: "scripts",
              reason: "invalid_protocol_value",
              count: invalidClaims,
            },
          ],
    );
  }
});

it("rejects an empty script ID before retaining its metadata", () => {
  const events = captureEvents();
  events.beginAuthorizedFrame(new CdpTargetDocument({ frameId: "frame-1" }));
  events.ingest(
    receiveCdpEvent({
      method: "Debugger.scriptParsed",
      params: { scriptId: "", url: "https://app.example/app.js" },
    }),
  );
  expect(events.scripts.size).toBe(0);
  expect(events.retainedScriptMetadataBytes).toBe(0);
  expect(events.completeness.snapshot().excluded).toContainEqual({
    section: "scripts",
    reason: "invalid_protocol_value",
    count: 1,
  });
});
