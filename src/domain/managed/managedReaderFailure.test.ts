import { describe, expect, it } from "vitest";

import {
  AnalysisTargetFailureError,
  AnalysisUnsupportedTargetError,
} from "../analysisErrorCore.js";
import { projectAnalysisError } from "../analysisErrorProjection.js";
import {
  managedFailure,
  managedInspectionTargetFailure,
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
    expect(failure).toBeInstanceOf(AnalysisTargetFailureError);
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
    expect(failure).toBeInstanceOf(AnalysisTargetFailureError);
    expect((failure as AnalysisTargetFailureError).failure).not.toHaveProperty(
      "offset",
    );
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
