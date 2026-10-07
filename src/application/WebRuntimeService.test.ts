import { expect, it } from "vitest";
import { WebRuntimeService } from "./WebRuntimeService.js";
import {
  recordingWebRuntimePort,
  webListenersFixture,
} from "./WebRuntimeService.fixture.js";
import { err, ok } from "../domain/result.js";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";

it("rejects malformed input and prior cancellation without calling a provider", async () => {
  const provider = recordingWebRuntimePort();
  const service = new WebRuntimeService({
    identity: () => provider.identity(),
    observeExecution: () => {
      throw new Error("Provider must not be called");
    },
    inspectEventListeners: () => {
      throw new Error("Provider must not be called");
    },
  });
  const malformed = await service.observe({
    cdp_endpoint: "https://remote.example",
    target_id: "page",
  });
  if (malformed.ok)
    throw new Error("Invalid endpoint must fail before execution");
  expect(malformed.error._tag).toBe("AnalysisInputError");
  const cancelled = await service.inspect({}, { signal: AbortSignal.abort() });
  if (cancelled.ok)
    throw new Error("Prior cancellation must fail before inspection");
  expect(cancelled.error._tag).toBe("AnalysisCancelledError");
});

it("preserves actual provider failures and rejects changed target/selector identities", async () => {
  const provider = recordingWebRuntimePort();
  const args = {
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "selected-page",
    selector: "#selected",
  };
  const captured = webListenersFixture();
  const timeout = new AnalysisTimeoutError("observe_web_execution", 20_000);
  const service = new WebRuntimeService({
    identity: () => provider.identity(),
    observeExecution: async () => err(timeout),
    inspectEventListeners: async () =>
      ok({
        ...captured,
        selected_node: { ...captured.selected_node, selector: "#different" },
      }),
  });
  const failed = await service.observe({
    cdp_endpoint: args.cdp_endpoint,
    target_id: args.target_id,
    observation_ms: 5,
  });
  expect(failed).toEqual(err(timeout));
  const changed = await service.inspect(args);
  if (changed.ok) throw new Error("Changed selection must be rejected");
  expect(changed.error._tag).toBe("AnalysisOutputError");
});
