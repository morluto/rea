import { expect, it } from "vitest";

import { BrowserObservationError } from "../../domain/browserObservationError.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { err } from "../../domain/result.js";
import type { JavaScriptRuntimeObservationPort } from "./JavaScriptRuntimeObservationPort.js";
import { observeJavaScriptRuntime } from "./JavaScriptRuntimeObservationService.js";

it("preserves failed Inspector cleanup when cancellation occurs during observation", async () => {
  const controller = new AbortController();
  const failure = new BrowserObservationError(
    "observe_javascript_runtime",
    "cleanup_failed",
    {
      cause: new AnalysisCancelledError("observe_javascript_runtime"),
    },
  );
  const provider: JavaScriptRuntimeObservationPort = {
    identity: () => ({
      id: "test-inspector",
      name: "Test Inspector",
      version: "1",
    }),
    listTargets: async () => err(failure),
    observe: async () => {
      controller.abort();
      return err(failure);
    },
  };
  const result = await observeJavaScriptRuntime(
    provider,
    {
      inspector_endpoint: "http://127.0.0.1:9229",
      target_id: "target",
      observation_ms: 0,
    },
    { signal: controller.signal },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failed cleanup");
  expect(result.error).toBe(failure);
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(result.error.cleanupResources).toEqual(["browser_transport"]);
  expect(result.error.userCategory).toBe("cancelled");
});
