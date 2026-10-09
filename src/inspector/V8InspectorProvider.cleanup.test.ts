import { expect, it } from "vitest";

import {
  closeInspectorConnection,
  inspectorCleanupError,
} from "./V8InspectorProvider.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisErrorProjectionSchema } from "../contracts/errorSchemas.js";
import { javascriptRuntimeObservationSchema } from "../domain/javascript/javascriptRuntimeObservation.js";

it("returns promptly on cancellation while a V8 socket close is hung", async () => {
  const controller = new AbortController();
  let closeStarted = false;
  const closing = closeInspectorConnection(
    {
      close: () => {
        closeStarted = true;
        return new Promise<void>(() => undefined);
      },
    },
    controller.signal,
  );

  controller.abort();
  expect(closeStarted).toBe(true);
  await expect(closing).resolves.toBeUndefined();
});

it("maps a rejected close to incomplete cleanup and preserves the primary failure", () => {
  const primary = new Error("observation failed");
  const cleanup = new Error("socket close failed");
  const error = inspectorCleanupError(primary, cleanup, true);

  expect(error.reason).toBe("cleanup_failed");
  expect(error.cleanupIncomplete).toBe(true);
  expect(error.cleanupResources).toEqual(["browser_transport"]);
  expect(error.cause).toBeInstanceOf(AggregateError);
  expect(error.cause).toMatchObject({ errors: [primary, cleanup] });
});

it("projects a completed runtime observation with the cleanup failure", () => {
  const observation = javascriptRuntimeObservationSchema.parse({
    runtime: {
      product: "Node.js",
      protocol_version: "1.3",
      v8_version: "12.0",
    },
    target: {
      target_id: "target-1",
      protocol_type: "node",
      attached: false,
      location: { kind: "file", file_path: "/fixture.js" },
      runtime_kind: "node",
      runtime_kind_authority: "caller-declared-unverified",
    },
    capture: {
      observation_ms: 0,
      events_observed: 0,
      events_retained: 0,
      events_dropped: 0,
      metadata_bytes_retained: 0,
      truncated: false,
      truncation_reasons: [],
    },
    scripts: {
      items: [],
      observed_total: 0,
      excluded: { unsupported_location: 0, invalid_protocol_value: 0 },
    },
    execution_contexts: [],
    directly_observed: ["Inspector target attached and queried."],
    unavailable_without_instrumentation: [],
    unknowns: [],
    limitations: [],
  });
  const primary = new Error("observation failed");
  const cleanup = new Error("socket close failed");
  const error = inspectorCleanupError(primary, cleanup, true, observation);
  const cause = error.cause;
  expect(cause).toBeInstanceOf(AggregateError);
  expect(cause).toMatchObject({ errors: [primary, cleanup] });

  const projected = projectAnalysisError(error);
  expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(true);
  expect(projected).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      cleanup_reason: "socket close failed",
      resources: ["browser_transport"],
      partial_observation: observation,
    },
  });
});
