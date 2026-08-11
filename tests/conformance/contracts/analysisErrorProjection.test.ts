import { describe, expect, it } from "vitest";

import { ProcessCaptureError } from "../../../src/application/ProcessCaptureError.js";
import { analysisErrorProjectionSchema } from "../../../src/contracts/errorSchemas.js";
import {
  ArtifactOperationError,
  EvidenceFileError,
  HopperRemoteError,
  InvestigationWorkspaceError,
  UnknownRegistryError,
  projectAnalysisError,
  type AnalysisError,
} from "../../../src/domain/errors.js";

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
          "policy",
          "unavailable",
          "io",
        ] as const
      ).map(
        (reason) => new ArtifactOperationError("inventory_artifact", reason),
      ),
      ...(
        [
          "disabled",
          "outside-root",
          "not-file",
          "too-large",
          "exists",
          "invalid-json",
          "io",
        ] as const
      ).map((reason) => new EvidenceFileError("read", reason)),
      ...(
        [
          "disabled",
          "outside-root",
          "not-file",
          "too-large",
          "invalid-json",
          "integrity",
          "locked",
          "revision-conflict",
          "name-conflict",
          "io",
        ] as const
      ).map((reason) => new InvestigationWorkspaceError("update", reason)),
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
      ...(
        [
          "capture_failed",
          "cleanup_incomplete",
          "permission_required",
          "cancelled",
        ] as const
      ).map(
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
      ).map((diagnostic) => new HopperRemoteError(9, "safe", diagnostic)),
    ];

    expect(variants).toHaveLength(39);
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
