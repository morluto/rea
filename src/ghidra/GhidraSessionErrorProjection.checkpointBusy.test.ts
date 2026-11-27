import { describe, expect, it } from "vitest";

import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  GhidraCheckpointBusyError,
  GhidraCheckpointSupersededError,
} from "./GhidraCheckpoint.js";
import { GhidraSessionError } from "./GhidraSessionError.js";
import { projectSessionError } from "./GhidraSessionErrorProjection.js";

describe("a checkpoint being saved by another session", () => {
  it("projects as retryable contention, not as an invalid setting", () => {
    const busy = new GhidraCheckpointBusyError(
      "/private/checkpoints",
      { runId: "run-a", processId: 4242 },
      { waitMs: 1_200, source: "setting" },
    );
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
    // The exhausted wait is a launch control: name it, its value and range.
    expect(projected.limit).toEqual({
      control_kind: "environment",
      environment: "REA_GHIDRA_CHECKPOINT_SAVE_WAIT_MS",
      effective_value: 1_200,
      unit: "ms",
      minimum: 50,
      maximum: 600_000,
      default_value: 30_000,
      applies_at: "next_startup",
    });
    for (const text of [projected.message, projected.remediationAction])
      expect(text).toContain(
        "REA_GHIDRA_CHECKPOINT_SAVE_WAIT_MS is 1200 ms (source launch environment; default 30000, floor 50, maximum 600000)",
      );
    expect(projected.remediationAction).toContain(
      "environment that starts REA and restart REA",
    );
    expect(projectAnalysisError(projected, "continuing").details).toMatchObject(
      {
        limit: {
          control_kind: "environment",
          environment: "REA_GHIDRA_CHECKPOINT_SAVE_WAIT_MS",
          effective_value: 1_200,
        },
      },
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
