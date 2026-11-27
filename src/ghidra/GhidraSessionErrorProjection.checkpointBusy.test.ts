import { describe, expect, it } from "vitest";

import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import {
  GhidraCheckpointBusyError,
  GhidraCheckpointSupersededError,
} from "./GhidraCheckpoint.js";
import { GhidraSessionError } from "./GhidraSessionError.js";
import { projectSessionError } from "./GhidraSessionErrorProjection.js";

const project = (cause: Error) =>
  projectSessionError(
    "list_documents",
    new GhidraSessionError("checkpoint", cause.message, {}, { cause }),
    {
      limits: { ghidraStartupTimeoutMs: 1_000 },
      programName: undefined,
      source: "owned-checkpoint",
    },
  );

describe("a checkpoint held by another session", () => {
  it("projects as retryable contention, not as an invalid setting", () => {
    const busy = new GhidraCheckpointBusyError("/private/checkpoints", {
      runId: "run-a",
      processId: 4242,
    });
    const projected = project(busy);
    if (!(projected instanceof AnalysisCapabilityUnavailableError))
      throw new Error(`unexpected projection: ${projected.name}`);
    expect(projected.retryable).toBe(true);
    expect(projected.message).toContain("another REA session");
    expect(projected.message).toContain("run-a");
    expect(projected.remediationAction).toContain(
      "Wait for that session to close the target",
    );
    expect(projected.remediationAction).not.toContain(
      "Correct REA_GHIDRA_CHECKPOINT_DIR",
    );
  });

  it("tells a retry after the owner saved edits to reopen the target", () => {
    const busy = project(
      new GhidraCheckpointBusyError("/private/checkpoints", {
        runId: "run-a",
        processId: 4242,
      }),
    );
    if (!(busy instanceof AnalysisCapabilityUnavailableError))
      throw new Error(`unexpected projection: ${busy.name}`);
    expect(busy.remediationAction).toContain(
      "reports that the checkpoint changed; then reopen the target",
    );
    const superseded = project(
      new GhidraCheckpointSupersededError("/private/checkpoints"),
    );
    if (!(superseded instanceof AnalysisCapabilityUnavailableError))
      throw new Error(`unexpected projection: ${superseded.name}`);
    expect(superseded.retryable).toBe(false);
    expect(superseded.remediationAction).toContain("call open_binary again");
    expect(superseded.remediationAction).not.toContain("repeat this call");
  });
});
