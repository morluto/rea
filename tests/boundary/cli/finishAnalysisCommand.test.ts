import { expect, it } from "vitest";

import { finishAnalysisCommand } from "../../../src/cli/finishAnalysisCommand.js";
import { AnalysisOutputError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok } from "../../../src/domain/result.js";
import { scriptCaptureEvidenceFixture } from "../../fixtures/webScriptCapture.js";

it("preserves producer-owned cleanup failure when service close does not resolve it", async () => {
  const evidence = scriptCaptureEvidenceFixture();
  const failure = new ProviderCleanupError(
    "fixture-provider",
    ["producer-owned-resource"],
    { reason: "producer cleanup was not confirmed" },
    { operation: "inspect_web_page", partialObservation: evidence },
  );
  const expected = projectAnalysisError(failure);
  const result = await finishAnalysisCommand(
    async () => err(failure),
    { close: async () => {} },
    "fixture-provider",
    "inspect_web_page",
    new AbortController().signal,
  );

  expect(result).toEqual(expected);
  expect(failure.cleanupIncomplete).toBe(true);
});

it("returns completed partial Evidence when cancellation arrives during close", async () => {
  const evidence = scriptCaptureEvidenceFixture();
  const controller = new AbortController();
  const result = await finishAnalysisCommand(
    async () => ok(evidence),
    {
      close: async () => {
        controller.abort(new Error("cancelled during close"));
      },
    },
    "fixture-provider",
    "capture_browser_scenario",
    controller.signal,
  );

  expect(result).toMatchObject({
    code: "cancelled",
    details: { partial_observation: { evidence_id: evidence.evidence_id } },
  });
});

it("preserves the primary operation error when cancellation arrives during close", async () => {
  const controller = new AbortController();
  const result = await finishAnalysisCommand(
    async () =>
      err(new AnalysisOutputError("inspect_web_page", "primary failure")),
    {
      close: async () => {
        controller.abort();
      },
    },
    "fixture-provider",
    "inspect_web_page",
    controller.signal,
  );

  expect(result).toMatchObject({
    code: "unreadable_output",
    details: {
      reason: "primary failure",
      operation: "inspect_web_page",
    },
  });
});

it("retains late cancellation and completed Evidence when close also fails", async () => {
  const evidence = scriptCaptureEvidenceFixture();
  const controller = new AbortController();
  const cleanup = new ProviderCleanupError(
    "fixture-provider",
    ["retained connection"],
    { reason: "close failed" },
  );
  const result = await finishAnalysisCommand(
    async () => ok(evidence),
    {
      close: async () => {
        controller.abort({ during: "close" });
        throw cleanup;
      },
    },
    "fixture-provider",
    "inspect_web_page",
    controller.signal,
  );
  expect(result).toMatchObject({
    code: "cleanup_incomplete",
    category: "cancelled",
    details: {
      partial_observation: evidence,
      diagnostics: {
        primary_error: { code: "cancelled" },
        cleanup_error: { details: { resources: ["retained connection"] } },
      },
    },
  });
});

it.each([false, true])(
  "recovers only producer-attested completed output after confirmed cleanup (cancel=%s)",
  async (cancel) => {
    const evidence = scriptCaptureEvidenceFixture();
    const controller = new AbortController();
    const failure = new ProviderCleanupError(
      "fixture-provider",
      ["root"],
      { reason: "initial cleanup refused" },
      {
        operation: "inspect_web_page",
        partialObservation: evidence,
        completedObservation: evidence,
      },
    );
    const result = await finishAnalysisCommand(
      async () => err(failure),
      {
        close: async () => {
          failure.resolveCleanup();
          if (cancel) controller.abort("cancelled during successful retry");
        },
      },
      "fixture-provider",
      "inspect_web_page",
      controller.signal,
      undefined,
      { recoverCompletedObservation: (observation) => observation },
    );
    if (!cancel) expect(result).toEqual(evidence);
    else
      expect(result).toMatchObject({
        code: "cancelled",
        details: {
          partial_observation: evidence,
          diagnostics: {
            cleanup_history: {
              details: { diagnostics: { reason: "initial cleanup refused" } },
            },
          },
        },
      });
  },
);

it.each(["unresolved", "ordinary-partial", "initial-projection"] as const)(
  "does not recover %s cleanup output",
  async (kind) => {
    const evidence = scriptCaptureEvidenceFixture();
    const failure = new ProviderCleanupError(
      "fixture-provider",
      ["root"],
      { reason: "cleanup refused" },
      {
        partialObservation: evidence,
        ...(kind === "ordinary-partial"
          ? {}
          : { completedObservation: evidence }),
      },
    );
    const initial = projectAnalysisError(failure);
    let attemptedRecovery = false;
    const result = await finishAnalysisCommand(
      async () => err(failure),
      {
        close: async () => {
          if (kind !== "unresolved") failure.resolveCleanup();
        },
      },
      "fixture-provider",
      "inspect_web_page",
      new AbortController().signal,
      undefined,
      {
        ...(kind === "initial-projection"
          ? { failureProjection: "initial" as const }
          : {}),
        recoverCompletedObservation: (observation) => {
          attemptedRecovery = true;
          return observation;
        },
      },
    );
    expect(attemptedRecovery).toBe(false);
    expect(result).toEqual(
      kind === "initial-projection" ? initial : projectAnalysisError(failure),
    );
  },
);
