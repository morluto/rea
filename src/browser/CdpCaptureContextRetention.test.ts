import type { CdpContextFrameClaim } from "./CdpScriptContextFacts.js";
import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import { describe, expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { CdpTargetDocument } from "./CdpTargetDocument.js";
import {
  ingestElectronScriptEvent,
  type ElectronScriptDraft,
} from "./CdpElectronScriptEvents.js";
import { receiveCdpEvent, type CdpEvent } from "./CdpConnection.js";

describe("CDP execution-context retention", () => {
  it.each([
    {
      frameId: "",
      hasSourceURL: true,
      expectedFrame: null,
      expectedLabel: true,
    },
    {
      frameId: "frame-other",
      hasSourceURL: true,
      expectedFrame: null,
      expectedLabel: true,
    },
    {
      frameId: "frame-main",
      hasSourceURL: "invalid",
      expectedFrame: "frame-main",
      expectedLabel: null,
    },
  ])(
    "keeps contradictory Electron ownership and invalid source labels uncertain: $frameId/$hasSourceURL",
    ({ frameId, hasSourceURL, expectedFrame, expectedLabel }) => {
      const scripts: ElectronScriptDraft[] = [];
      const completeness = new CdpCaptureCompleteness();
      const retention = { bytes: 2 };
      ingestElectronScriptEvent({
        event: receiveCdpEvent({
          method: "Debugger.scriptParsed",
          params: {
            scriptId: "script",
            url: "file:///fixture/app.js",
            executionContextId: 7,
            executionContextAuxData: { frameId },
            hasSourceURL,
          },
        }),
        scripts,
        retention,
        executionContextFrames: new Map<string, CdpContextFrameClaim>([
          ["7", { state: "observed", frameId: "frame-main" }],
        ]),
        completeness,
      });
      expect(scripts[0]).toMatchObject({
        frameId: expectedFrame,
        hasSourceUrl: expectedLabel,
        frameClaims: {
          script_event_frame_id: frameId,
          execution_context_frame_id: "frame-main",
        },
      });
      expect(retention.bytes).toBe(
        jsonValueByteLength(scripts.map((script) => ({ ...script }))),
      );
      expect(completeness.snapshot().excluded).toContainEqual({
        section: "scripts",
        reason: "invalid_protocol_value",
        count: 1,
      });
    },
  );
});

const startScriptTrace = () => {
  const origin = "https://app.example.test";
  const browser = new CdpCaptureEvents(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: [origin],
      target_id: "page-1",
    }),
    new Set([origin]),
  );
  browser.beginAuthorizedFrame(new CdpTargetDocument({ frameId: "frame-old" }));
  const scripts: ElectronScriptDraft[] = [];
  const executionContextFrames = new Map<string, CdpContextFrameClaim>();
  const completeness = new CdpCaptureCompleteness();
  const retention = { bytes: 2 };
  const emit = (event: CdpEvent) => {
    const received = receiveCdpEvent(event);
    browser.ingest(received);
    ingestElectronScriptEvent({
      event: received,
      scripts,
      executionContextFrames,
      completeness,
      retention,
    });
  };
  return {
    browser,
    executionContextFrames,
    emit,
    createContext: (id: number, frameId: string) =>
      emit({
        method: "Runtime.executionContextCreated",
        params: { context: { id, auxData: { frameId } } },
      }),
    parseScript: (scriptId: string, executionContextId: number) =>
      emit({
        method: "Debugger.scriptParsed",
        params: { scriptId, url: `${origin}/app.js`, executionContextId },
      }),
    expectFrames: (entries: readonly (readonly [string, string | null])[]) => {
      const allowed = new Set(["frame-old", "frame-new", "frame-sibling"]);
      expect(
        [...browser.scripts.values()].map(({ scriptId, frameId }) => [
          scriptId,
          frameId,
        ]),
      ).toEqual(entries);
      expect(
        [...browser.scripts.values()].map((script) => [
          script.scriptId,
          browser.frameForScript(script, allowed),
        ]),
      ).toEqual(entries);
      expect(
        scripts.map(({ scriptId, frameId }) => [scriptId, frameId]),
      ).toEqual(entries);
      expect(retention.bytes).toBe(
        jsonValueByteLength(scripts.map((script) => ({ ...script }))),
      );
    },
  };
};

it("keeps parsed frames through context reuse, scoped destruction and global clearing", () => {
  const trace = startScriptTrace();
  trace.createContext(7, "frame-old");
  trace.parseScript("original", 7);
  trace.createContext(7, "frame-new");
  trace.parseScript("replacement", 7);
  trace.createContext(8, "frame-sibling");

  trace.emit({
    method: "Runtime.executionContextDestroyed",
    params: { executionContextId: 7 },
  });
  trace.parseScript("destroyed", 7);
  trace.parseScript("sibling", 8);
  trace.emit({ method: "Runtime.executionContextsCleared", params: {} });
  trace.parseScript("cleared", 8);
  trace.expectFrames([
    ["original", "frame-old"],
    ["replacement", "frame-new"],
    ["destroyed", null],
    ["sibling", "frame-sibling"],
    ["cleared", null],
  ]);
  const original = trace.browser.scripts.get("original");
  if (original === undefined) throw new Error("Expected an earlier script");
  expect(
    trace.browser.frameForScript(original, new Set(["frame-new"])),
  ).toBeNull();
});

it("revokes reused context authority for each incomplete frame claim", () => {
  const trace = startScriptTrace();
  const expected: Array<[string, string | null]> = [];
  for (const [index, [replacement, claim]] of (
    [
      [{}, { state: "missing", frameId: undefined }],
      [{ auxData: {} }, { state: "missing", frameId: undefined }],
      [{ auxData: { frameId: "" } }, { state: "invalid", frameId: "" }],
      [
        { auxData: { frameId: null } },
        { state: "invalid", frameId: undefined },
      ],
      [{ auxData: { frameId: 42 } }, { state: "invalid", frameId: undefined }],
      [{ auxData: null }, { state: "invalid", frameId: undefined }],
    ] as const
  ).entries()) {
    const id = index + 7;
    const before = `before-${String(id)}`;
    const after = `after-${String(id)}`;
    trace.createContext(id, "frame-old");
    trace.parseScript(before, id);
    trace.emit({
      method: "Runtime.executionContextCreated",
      params: { context: { id, ...replacement } },
    });
    trace.parseScript(after, id);
    expect(trace.executionContextFrames.get(String(id))).toEqual(claim);
    expect(trace.browser.executionContextFrames.get(String(id))).toEqual(claim);
    expected.push([before, "frame-old"], [after, null]);
  }
  trace.expectFrames(expected);
});
