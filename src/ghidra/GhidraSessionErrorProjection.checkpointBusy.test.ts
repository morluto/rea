import { describe, expect, it } from "vitest";

import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import {
  GhidraCheckpointBusyError,
  GhidraCheckpointSupersededError,
} from "./GhidraCheckpoint.js";
import { GhidraSessionError } from "./GhidraSessionError.js";
import { projectSessionError } from "./GhidraSessionErrorProjection.js";

describe("a checkpoint being saved by another session", () => {
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
      "Wait for that session's save to finish",
    );
    expect(projected.remediationAction).not.toContain(
      "Correct REA_GHIDRA_CHECKPOINT_DIR",
    );
  });

  it("projects a superseded restore as a reopen, not as an invalid setting", () => {
    const superseded = new GhidraCheckpointSupersededError(
      "/private/checkpoints",
      "restore",
    );
    const projected = projectSessionError(
      "list_documents",
      new GhidraSessionError(
        "checkpoint",
        superseded.message,
        {},
        { cause: superseded },
      ),
      {
        limits: { ghidraStartupTimeoutMs: 1_000 },
        programName: undefined,
        source: "owned-checkpoint",
      },
    );
    if (!(projected instanceof AnalysisCapabilityUnavailableError))
      throw new Error(`unexpected projection: ${projected.name}`);
    // The session's profile commits to the superseded generation.
    expect(projected.retryable).toBe(false);
    expect(projected.message).toContain("reopen the target");
    expect(projected.remediationAction).toContain("open_binary");
    expect(projected.remediationAction).toContain("needs no change");
  });
});
