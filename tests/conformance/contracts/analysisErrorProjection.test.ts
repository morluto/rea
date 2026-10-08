import { describe, expect, it } from "vitest";

import { ProcessCaptureError } from "../../../src/process/capture/ProcessCaptureError.js";
import { analysisErrorProjectionSchema } from "../../../src/contracts/errorSchemas.js";
import { ArtifactOperationError } from "../../../src/domain/artifactOperationError.js";
import { EvidenceFileError } from "../../../src/domain/evidenceErrors.js";
import { HopperRemoteError } from "../../../src/domain/hopperErrors.js";
import { UnknownRegistryError } from "../../../src/domain/unknownRegistryError.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { type AnalysisError } from "../../../src/domain/analysisErrorBase.js";

describe("analysis error projection contract", () => {
  it("accepts every closed error-reason variant without exposing diagnostics", () => {
    const variants: AnalysisError[] = [
      ...(
        [
          "cancelled",
          "format",
          "integrity",
          "limit",
          "path",
          "unavailable",
          "io",
        ] as const
      ).map(
        (reason) => new ArtifactOperationError("inventory_artifact", reason),
      ),
      ...(["not-file", "exists", "invalid-json", "missing", "io"] as const).map(
        (reason) => new EvidenceFileError("read", reason),
      ),
      ...(
        [
          "not-found",
          "already-exists",
          "revision-conflict",
          "invalid-transition",
          "integrity",
          "limit",
        ] as const
      ).map((reason) => new UnknownRegistryError(reason)),
      ...(["capture_failed", "cleanup_incomplete", "cancelled"] as const).map(
        (reason) =>
          new ProcessCaptureError("SECRET capture diagnostic", { reason }),
      ),
      ...(
        [
          "remote",
          "authorization",
          "invalid_request",
          "bridge_exception",
        ] as const
      ).map(
        (diagnostic) =>
          new HopperRemoteError(9, "safe", { diagnosticType: diagnostic }),
      ),
    ];

    for (const variant of variants) {
      const projected = projectAnalysisError(variant);
      expect(
        analysisErrorProjectionSchema.safeParse(projected),
        JSON.stringify({ variant, projected }),
      ).toMatchObject({ success: true });
      expect(projected.code).toMatch(/^[a-z][a-z0-9_]*$/u);
      expect(JSON.stringify(projected)).not.toContain("SECRET");
    }
  });
});
