import { describe, expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import { ingestElectronScriptEvent } from "./CdpElectronScriptEvents.js";

describe("CDP execution-context retention", () => {
  it("removes stale frame attribution when execution contexts are destroyed", () => {
    const request = inspectWebPageInputSchema.parse({
      cdp_endpoint: "http://127.0.0.1:9222",
      allowed_origins: ["https://app.example.test"],
      target_id: "page-1",
      approved: true,
    });
    const browser = new CdpCaptureEvents(
      request,
      new Set(["https://app.example.test"]),
    );
    browser.beginAuthorizedFrame("frame-old");
    browser.ingest({
      method: "Runtime.executionContextCreated",
      params: { context: { id: 7, auxData: { frameId: "frame-old" } } },
    });
    browser.ingest({
      method: "Runtime.executionContextDestroyed",
      params: { executionContextId: 7 },
    });
    browser.ingest({
      method: "Debugger.scriptParsed",
      params: {
        scriptId: "script-1",
        url: "https://app.example.test/app.js",
        executionContextId: 7,
      },
    });
    const script = browser.scripts.get("script-1");
    if (script === undefined) throw new TypeError("Expected captured script");
    expect(browser.frameForScript(script, new Set(["frame-old"]))).toBeNull();

    const electronFrames = new Map<string, string>();
    const completeness = new CdpCaptureCompleteness();
    ingestElectronScriptEvent({
      event: {
        method: "Runtime.executionContextCreated",
        params: { context: { id: 7, auxData: { frameId: "frame-old" } } },
      },
      scripts: [],
      executionContextFrames: electronFrames,
      completeness,
    });
    ingestElectronScriptEvent({
      event: { method: "Runtime.executionContextsCleared", params: {} },
      scripts: [],
      executionContextFrames: electronFrames,
      completeness,
    });
    expect(electronFrames.size).toBe(0);
  });
});
