import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import * as stableArtifact from "../../artifacts/readStableArtifact.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { inspectNtfsJournalEvidence } from "./NtfsJournalService.js";

it.each([
  ["EACCES", "access_denied"],
  ["EIO", "artifact_operation_failed"],
])(
  "preserves the acquisition failure category for %s",
  async (systemCode, expectedCode) => {
    const resources = new ArtifactResourceScope();
    const spy = vi
      .spyOn(stableArtifact, "readStableArtifact")
      .mockRejectedValueOnce(
        Object.assign(new Error("acquisition read failed"), {
          code: systemCode,
        }),
      );
    try {
      const result = await inspectNtfsJournalEvidence(
        {
          mft_path: "/fixture/mft",
          journal_path: "/fixture/journal",
        },
        resources,
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected acquisition failure");
      expect(projectAnalysisError(result.error).code).toBe(expectedCode);
    } finally {
      spy.mockRestore();
      await resources.close();
    }
  },
);
