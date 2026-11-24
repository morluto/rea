import { describe, expect, it } from "vitest";

import {
  AnalysisMalformedTargetError,
  AnalysisUnsupportedTargetError,
} from "../analysisErrorCore.js";
import { projectAnalysisError } from "../analysisErrorProjection.js";
import type { ManagedParseIssue } from "./managedArtifact.js";
import {
  managedFailure,
  managedInspectionTargetFailure,
  managedMetadataFailureStatus,
  retainManagedValueFailure,
} from "./managedReaderFailure.js";

const OPERATION = "inspect_managed_members";
const PATH = "/fixture.dll";

describe("managedInspectionTargetFailure", () => {
  it("refuses a broken PE/CLI rule as a malformed target with the reader's location", () => {
    const failure = managedInspectionTargetFailure(
      OPERATION,
      PATH,
      managedFailure(
        "invalid-directory",
        "pe.section-data",
        "pe.section-data leaves the artifact byte range",
        0x2000,
      ),
    );
    expect(failure).toBeInstanceOf(AnalysisMalformedTargetError);
    expect(projectAnalysisError(failure!)).toMatchObject({
      code: "unsupported_target",
      retryable: false,
      details: {
        operation: OPERATION,
        path: PATH,
        format_failure: "malformed",
        format: "pe-cli",
        field: "pe.section-data",
        offset: 0x2000,
        reason: "pe.section-data leaves the artifact byte range",
      },
    });
    expect(projectAnalysisError(failure!)).not.toHaveProperty("recovery");
  });

  it("omits an unknown offset rather than inventing one", () => {
    const failure = managedInspectionTargetFailure(
      OPERATION,
      PATH,
      managedFailure("invalid-tables", "metadata.tables", "bad table"),
    );
    expect(failure).toBeInstanceOf(AnalysisMalformedTargetError);
    expect(
      (failure as AnalysisMalformedTargetError).failure,
    ).not.toHaveProperty("offset");
  });

  it.each(["unsupported-metadata", "unsupported-signature"] as const)(
    "keeps %s outside decoder coverage unsupported, never malformed",
    (code) => {
      const failure = managedInspectionTargetFailure(
        OPERATION,
        PATH,
        managedFailure(code, "metadata.tables", "a newer layout"),
      );
      expect(failure).toBeInstanceOf(AnalysisUnsupportedTargetError);
      expect(failure).toMatchObject({ path: PATH, reason: "a newer layout" });
    },
  );

  it.each([
    ["resource-limit", "partial"],
    ["unsupported-metadata", "partial"],
    ["unsupported-signature", "partial"],
    ["invalid-blob", "malformed"],
    ["invalid-tables", "malformed"],
    ["invalid-directory", "malformed"],
  ] as const)(
    "reports %s as %s metadata, matching the refusal's classification",
    (code, status) => {
      const issue = managedFailure(code, "metadata.tables", "detail").issue;
      expect(managedMetadataFailureStatus(issue)).toBe(status);
      const refusal = managedInspectionTargetFailure(
        OPERATION,
        PATH,
        managedFailure(code, "metadata.tables", "detail"),
      );
      // Only a broken rule is malformed in both the inventory and a refusal.
      expect(refusal instanceof AnalysisMalformedTargetError).toBe(
        status === "malformed",
      );
    },
  );

  it.each([
    ["unsupported-signature", "retained"],
    ["invalid-blob", "retained"],
    ["unsupported-metadata", "escapes"],
    ["resource-limit", "escapes"],
  ] as const)(
    "keeps one value's %s local or stops the whole read: %s",
    (code, outcome) => {
      const issues: ManagedParseIssue[] = [];
      const cause = managedFailure(code, "metadata.TypeSpec:0x1b000001", "x");
      if (outcome === "retained") {
        expect(retainManagedValueFailure(cause, issues)).toBe(cause);
        expect(issues).toEqual([cause.issue]);
      } else {
        expect(() => retainManagedValueFailure(cause, issues)).toThrow(cause);
        expect(issues).toEqual([]);
      }
    },
  );

  it("leaves a resource limit and foreign causes to their producers", () => {
    expect(
      managedInspectionTargetFailure(
        OPERATION,
        PATH,
        managedFailure("resource-limit", "metadata.tables", "budget"),
      ),
    ).toBeUndefined();
    expect(
      managedInspectionTargetFailure(OPERATION, PATH, new Error("io")),
    ).toBeUndefined();
  });
});
