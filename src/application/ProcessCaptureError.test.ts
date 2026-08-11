import { describe, expect, it } from "vitest";

import { projectAnalysisError } from "../domain/errors.js";
import {
  ProcessCaptureError,
  processCaptureCancelled,
} from "./ProcessCaptureError.js";

describe("process capture error projection", () => {
  it("reports incomplete cleanup resources without exposing its cause", () => {
    const projected = projectAnalysisError(
      new ProcessCaptureError("terminal cleanup failed", {
        cause: new Error("secret-token"),
        reason: "cleanup_incomplete",
        cleanupResources: ["process_group"],
      }),
    );

    expect(projected).toMatchObject({
      code: "cleanup_incomplete",
      details: { cleanup: "incomplete", resources: ["process_group"] },
    });
    expect(JSON.stringify(projected)).not.toContain("secret-token");
  });

  it("projects caller cancellation as completed cleanup", () => {
    expect(projectAnalysisError(processCaptureCancelled())).toMatchObject({
      code: "cancelled",
      category: "cancelled",
      details: { operation: "process_capture", cleanup: "complete" },
    });
  });
});
