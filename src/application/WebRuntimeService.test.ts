import { expect, it } from "vitest";
import { WebRuntimeService } from "./WebRuntimeService.js";
import {
  recordingWebRuntimePort,
  webExecutionFixture,
  webListenersFixture,
} from "./WebRuntimeService.fixture.js";
import { err, ok } from "../domain/result.js";
import {
  AnalysisCancelledError,
  AnalysisOutputError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import {
  expectDroppedPartial,
  expectKeptPartial,
  expectOwnerError,
} from "../../tests/fixtures/ownerObservationExpectation.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { parseEvidence } from "../domain/evidence.js";

it.each(
  (["observe", "inspect"] as const).flatMap((operation) =>
    (
      [
        "valid",
        "sha256",
        "utf8_bytes",
        "utf16_units",
        "unavailable",
        "excluded",
      ] as const
    ).map((field) => ({ operation, field })),
  ),
)(
  "verifies $operation captured source facts for $field",
  async ({ operation, field }) => {
    const captured = {
      state: "captured" as const,
      text: 'const value = "🎋";',
      sha256:
        "2f5ea9ea003c0c49a16865421e2531b36218e82b46e0eeb10210e83288f24d2e",
      utf8_bytes: 21,
      utf16_units: 19,
    };
    const source = {
      script_id: "17",
      url: "https://app.test/main.js",
      execution_context_id: null,
      reported_execution_context: null,
      reported_script_context_aux_data: null,
      frame_id: "main-frame",
      producer_hash: null,
      source_map_url: null,
      has_source_url: false,
      language: "JavaScript",
      resource_start: null,
      source:
        field === "unavailable" || field === "excluded"
          ? { state: field, reason: "Source not retained" }
          : {
              ...captured,
              ...(field === "sha256" ? { sha256: "a".repeat(64) } : {}),
              ...(field === "utf8_bytes" ? { utf8_bytes: 22 } : {}),
              ...(field === "utf16_units" ? { utf16_units: 20 } : {}),
            },
    };
    const provider = recordingWebRuntimePort();
    const service = new WebRuntimeService({
      identity: provider.identity,
      observeExecution: async () =>
        ok({ ...webExecutionFixture(), sources: [source] }),
      inspectEventListeners: async () =>
        ok({ ...webListenersFixture(), sources: [source] }),
    });
    const scope = {
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "selected-page",
    };
    const result =
      operation === "observe"
        ? await service.observe({ ...scope, observation_ms: 5 })
        : await service.inspect({ ...scope, selector: "#selected" });
    const valid =
      field === "valid" || field === "unavailable" || field === "excluded";
    expect(result.ok).toBe(valid);
    if (result.ok)
      expect(result.value.normalized_result).toMatchObject({
        sources: [source],
      });
    else {
      expect(result.error._tag).toBe("AnalysisOutputError");
      expect(result.error.message).toContain(field);
    }
  },
);

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
  const reason = { requested: "stop before provider admission" };
  const cancelled = await service.inspect(
    {},
    { signal: AbortSignal.abort(reason) },
  );
  if (cancelled.ok)
    throw new Error("Prior cancellation must fail before inspection");
  expect(cancelled.error._tag).toBe("AnalysisCancelledError");
  expect(cancelled.error.cause).toBe(reason);
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

it("converts raw execution retained by provider cleanup failure into partial Evidence", async () => {
  const args = {
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "selected-page",
    observation_ms: 5,
  };
  const execution = webExecutionFixture(args.target_id, args.observation_ms);
  const failure = new ProviderCleanupError(
    "rea-cdp-browser",
    ["selected-page"],
    { reason: "target detach failed" },
    { operation: "observe_web_execution", partialObservation: execution },
  );
  const result = await new WebRuntimeService({
    identity: runtimeIdentity,
    observeExecution: async () => err(failure),
    inspectEventListeners: async () => err(failure),
  }).observe(args);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBe(failure);
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(parseEvidence(result.error.partialObservation)).toMatchObject({
      operation: "observe_web_execution",
      normalized_result: execution,
    });
  }
});

it("retains completed execution Evidence on late abort and keeps invalid output primary", async () => {
  const input = {
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "selected-page",
    observation_ms: 5,
  };
  const unused = new AnalysisTimeoutError(
    "inspect_web_event_listeners",
    20_000,
  );
  const controller = new AbortController();
  const cancellationReason = new Error(
    "caller cancelled the runtime observation",
  );
  const completed = await new WebRuntimeService({
    identity: () => ({
      id: "web-runtime",
      name: "Runtime fixture",
      version: "1",
    }),
    observeExecution: async () => {
      controller.abort(cancellationReason);
      return ok(webExecutionFixture(input.target_id, input.observation_ms));
    },
    inspectEventListeners: async () => err(unused),
  }).observe(input, { signal: controller.signal });
  if (completed.ok) throw new Error("Expected late cancellation");
  expect(completed.error._tag).toBe("AnalysisCancelledError");
  expect(completed.error.cause).toBe(cancellationReason);
  expect(parseEvidence(completed.error.partialObservation)).toMatchObject({
    operation: "observe_web_execution",
    provider: { id: "web-runtime", name: "Runtime fixture", version: "1" },
    parameters: input,
    confidence: "observed",
    authority: "external-service",
    limitations: expect.arrayContaining(
      webExecutionFixture(input.target_id, input.observation_ms).limitations,
    ),
    normalized_result: webExecutionFixture(
      input.target_id,
      input.observation_ms,
    ),
  });

  const late = new AbortController();
  const invalid = await new WebRuntimeService({
    identity: () => ({
      id: "web-runtime",
      name: "Runtime fixture",
      version: "1",
    }),
    observeExecution: async () => {
      late.abort();
      return ok(webExecutionFixture(input.target_id, input.observation_ms));
    },
    inspectEventListeners: async () => err(unused),
  }).observe(
    { ...input, allowed_origins: ["https://allowed.example"] },
    { signal: late.signal },
  );
  expect(invalid).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisOutputError" },
  });
  if (!invalid.ok) expect(invalid.error).toBeInstanceOf(AnalysisOutputError);
});

const runtimeIdentity = () => ({
  id: "web-runtime",
  name: "Runtime fixture",
  version: "1",
});

const callRuntime = (
  operation: "observe" | "inspect",
  failure: AnalysisError,
) => {
  const service = new WebRuntimeService({
    identity: runtimeIdentity,
    observeExecution: async () => err(failure),
    inspectEventListeners: async () => err(failure),
  });
  return operation === "observe"
    ? service.observe({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "selected-page",
        observation_ms: 5,
      })
    : service.inspect({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "selected-page",
        selector: "#selected",
      });
};

it.each([
  {
    operation: "observe" as const,
    partial: {
      instrumentation: { cleanup: "unconfirmed" },
      window: { requested_ms: 5 },
    },
  },
  {
    operation: "inspect" as const,
    partial: {
      selected_node: { selector: "#selected" },
      listeners: [],
    },
  },
])(
  "keeps $operation cancellation when the retained observation is incomplete",
  async ({ operation, partial }) => {
    const reason = { requested: `stop incomplete ${operation}` };
    const failure = new AnalysisCancelledError(
      operation === "observe"
        ? "observe_web_execution"
        : "inspect_web_event_listeners",
      { cause: reason, partialObservation: partial as never },
    );
    expectKeptPartial(
      expectOwnerError(await callRuntime(operation, failure), failure, reason),
      partial,
    );
  },
);

it.each([
  {
    operation: "observe" as const,
    partial: {
      instrumentation: { cleanup: "unconfirmed" },
      window: { requested_ms: Number.NaN },
    },
    reason: "Provider retained a non-JSON incomplete execution observation.",
  },
  {
    operation: "inspect" as const,
    partial: {
      selected_node: { selector: "#selected" },
      listeners: [undefined],
    },
    reason:
      "Provider retained a non-JSON incomplete event-listener observation.",
  },
])(
  "drops a non-JSON $operation partial and keeps cancellation primary",
  async ({ operation, partial, reason: outputReason }) => {
    const reason = { requested: `stop unsafe ${operation}` };
    const failure = new AnalysisCancelledError(
      operation === "observe"
        ? "observe_web_execution"
        : "inspect_web_event_listeners",
      { cause: reason, partialObservation: partial as never },
    );
    expectDroppedPartial(
      expectOwnerError(await callRuntime(operation, failure), failure, reason),
      outputReason,
    );
  },
);

it("drops a non-JSON execution partial and keeps timeout primary", async () => {
  const failure = new AnalysisTimeoutError("observe_web_execution", 5, {
    partialObservation: {
      instrumentation: { samples: [undefined] },
      window: { requested_ms: 5 },
    } as never,
  });
  const error = expectOwnerError(
    await callRuntime("observe", failure),
    failure,
    undefined,
  );
  expectDroppedPartial(
    error,
    "Provider retained a non-JSON incomplete execution observation.",
    "provider_timeout",
  );
  expect(projectAnalysisError(error).category).toBe("timeout");
});

it.each(["observe", "inspect"] as const)(
  "keeps %s cancellation primary when completed-shaped partial cannot be promoted within origin scope",
  async (operation) => {
    const partial =
      operation === "observe" ? webExecutionFixture() : webListenersFixture();
    const reason = { stop: "retained fact projection" };
    const failure = new AnalysisCancelledError(
      operation === "observe"
        ? "observe_web_execution"
        : "inspect_web_event_listeners",
      { cause: reason, partialObservation: partial },
    );
    const service = new WebRuntimeService({
      identity: runtimeIdentity,
      observeExecution: async () => err(failure),
      inspectEventListeners: async () => err(failure),
    });
    const input = {
      cdp_endpoint: "http://127.0.0.1:9222",
      target_id: "selected-page",
      allowed_origins: ["https://selected.example"],
    };
    const result =
      operation === "observe"
        ? await service.observe({ ...input, observation_ms: 5 })
        : await service.inspect({ ...input, selector: "#selected" });
    expect(result).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        cause: reason,
        partialObservation: partial,
      },
    });
    if (result.ok) throw new Error("Expected original cancellation");
    expect(result.error).toBe(failure);
    expect(result.error.partialObservation).not.toHaveProperty("evidence_id");
  },
);
