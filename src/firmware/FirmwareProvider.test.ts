import { describe, expect, it, vi } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok } from "../domain/result.js";
import { firmwareRequestSchema } from "../domain/firmware/firmwareAnalysis.js";
import { finishFirmwareWorkspace } from "./FirmwareProvider.js";

const request = firmwareRequestSchema.parse({
  operation: "extract_firmware",
  input: {
    path: "/tmp/firmware.bin",
    output_directory: "/tmp/extracted",
  },
});

const execution = ok({
  result: { files: ["kept"] },
  rawResult: null,
  provider: { id: "unblob", name: "unblob", version: "1" },
  limitations: [],
  locations: [],
  subject: null,
});

describe("firmware workspace cleanup", () => {
  it("returns the completed extraction beside a cleanup failure and does not delete the leaked root", async () => {
    const close = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const finished = await finishFirmwareWorkspace(
      { path: "/tmp/runtime", close },
      execution,
      "unblob",
      request,
    );
    expect(close).toHaveBeenCalledOnce();
    if (finished.ok || !(finished.error instanceof ProviderAdapterError))
      throw new Error("Expected cleanup failure");
    expect(finished.error.cleanupResources).toEqual([
      "/tmp/runtime",
      "/tmp/extracted",
    ]);
    expect(finished.error.partialObservation).toEqual({
      kind: "firmware",
      result: { files: ["kept"] },
    });
    expect(finished.error.diagnostics).toEqual({ reason: "cleanup failed" });
    expect(projectAnalysisError(finished.error).details).toMatchObject({
      partial_observation: {
        kind: "firmware",
        result: { files: ["kept"] },
      },
    });
  });

  it("does not replay a cleanup failure for a later workspace", async () => {
    const failed = await finishFirmwareWorkspace(
      {
        path: "/tmp/runtime",
        close: async () => {
          throw new Error("cleanup failed");
        },
      },
      execution,
      "unblob",
      request,
    );
    expect(failed.ok).toBe(false);
    const next = await finishFirmwareWorkspace(
      { path: "/tmp/next", close: async () => undefined },
      execution,
      "unblob",
      request,
    );
    expect(next).toBe(execution);
  });

  it("leaves an uncertain workspace recorded and does not remove it", async () => {
    const close = vi.fn(async () => undefined);
    const cleanup = new ProviderCleanupError(
      "unblob",
      ["/tmp/runtime"],
      { reason: "ownership uncertain" },
      { operation: "extract_firmware" },
    );
    const outcome = err(cleanup);
    const finished = await finishFirmwareWorkspace(
      { path: "/tmp/runtime", close },
      outcome,
      "unblob",
      request,
    );
    expect(close).not.toHaveBeenCalled();
    expect(finished).toBe(outcome);
  });
});
