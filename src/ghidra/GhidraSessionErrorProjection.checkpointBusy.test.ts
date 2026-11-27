import { describe, expect, it } from "vitest";

import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { GhidraCheckpointBusyError } from "./GhidraCheckpoint.js";
import { GhidraSessionError } from "./GhidraSessionError.js";
import { projectSessionError } from "./GhidraSessionErrorProjection.js";

describe("a checkpoint held by another session", () => {
  it("projects as retryable contention, not as an invalid setting", () => {
    const busy = new GhidraCheckpointBusyError("/private/checkpoints", {
      runId: "run-a",
      processId: 4242,
    });
    const projected = projectSessionError(
      "list_documents",
      new GhidraSessionError("checkpoint", busy.message, {}, { cause: busy }),
      {
        limits: { ghidraStartupTimeoutMs: 1_000 },
        programName: undefined,
        source: "owned-checkpoint",
      },
    );
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
});
