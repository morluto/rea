import { describe, expect, it } from "vitest";

import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { DesktopSessionCleanupError } from "../../desktop/DesktopApplicationSession.js";
import { failedCaptureError } from "./DesktopCaptureFailure.js";

describe("failedCaptureError", () => {
  it("returns the failure itself when everything was cleaned up", () => {
    const failure = new Error("walk failed");
    expect(failedCaptureError(failure, [])).toBe(failure);
  });

  it("reports the processes a failed session left with the failure as its cause", () => {
    const failure = new Error("checkpoint failed");
    const error = failedCaptureError(
      new DesktopSessionCleanupError(failure, {
        reason: "token-owned process remained after cleanup",
        resources: ["run-1", "pid:10", "process-group:10"],
      }),
      [
        {
          reason:
            "the content the failed capture retained could not be removed",
          resources: ["/out/content"],
        },
      ],
    );

    expect(error).toBeInstanceOf(ProviderAdapterError);
    const adapter = error as ProviderAdapterError;
    expect(adapter.cause).toBe(failure);
    expect(adapter.cleanup).toEqual({
      reason:
        "token-owned process remained after cleanup; the content the failed capture retained could not be removed",
      resources: ["run-1", "pid:10", "process-group:10", "/out/content"],
    });
    expect(adapter.userMessage).toContain("checkpoint failed");
  });

  it("keeps a typed failure as the cleanup primary", () => {
    const failure = new AnalysisInputError(
      "capture_desktop_application",
      { userMessage: "bad input", conformsToInputContract: true },
      [],
    );
    const error = failedCaptureError(failure, [
      { reason: "unpublished capture file remained", resources: ["/out/x"] },
    ]) as ProviderAdapterError;

    expect(error.cleanupPrimary).toBe(failure);
    expect(error.userMessage).toContain("bad input");
  });
});
