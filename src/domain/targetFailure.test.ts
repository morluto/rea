import { describe, expect, it } from "vitest";

import { AnalysisTargetFailureError } from "./analysisErrorCore.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import {
  TARGET_FAILURE_KINDS,
  targetFailureDetails,
  targetFailureRecovery,
  type TargetFailure,
  type TargetFailureKind,
} from "./targetFailure.js";
import { TARGET_FAILURE_CONTRACT } from "../../tests/support/targetFailure/contract.js";

const failureOf = (kind: TargetFailureKind): TargetFailure => {
  const facts = { format: "elf", detail: `${kind} detail`, offset: 4 };
  switch (kind) {
    case "unsupported":
      return { ...facts, kind, undecodedContent: false };
    case "truncated":
      return { ...facts, kind, availableBytes: 4, requiredBytes: 64 };
    case "conflict":
      return {
        ...facts,
        kind,
        inputs: [
          { field: "path", path: "/tmp/a" },
          { field: "binary_path", path: "/tmp/b" },
        ],
      };
    default:
      return { ...facts, kind };
  }
};

describe("target failure projection", () => {
  it.each(TARGET_FAILURE_KINDS)(
    "derives the public contract of %s from its kind",
    (kind) => {
      const { code, category, retryable } = TARGET_FAILURE_CONTRACT[kind];
      const failure = failureOf(kind);
      const projected = projectAnalysisError(
        new AnalysisTargetFailureError("inspect_elf_notes", "/tmp/t", failure),
      );
      expect(projected).toMatchObject({
        code,
        category,
        retryable,
        remediation: {
          action: targetFailureRecovery("inspect_elf_notes", failure),
        },
        details: {
          operation: "inspect_elf_notes",
          path: "/tmp/t",
          reason: failure.detail,
          failure_kind: kind,
          format: "elf",
          offset: 4,
        },
      });
      expect(projected).not.toHaveProperty("recovery");
    },
  );

  it("keeps format_failure only for the byte-structure kinds", () => {
    const reported = TARGET_FAILURE_KINDS.filter(
      (kind) => "format_failure" in targetFailureDetails(failureOf(kind)),
    );
    expect(reported).toEqual(["malformed", "truncated"]);
  });

  it("reports measured extents for a truncated structure", () => {
    expect(targetFailureDetails(failureOf("truncated"))).toEqual({
      format_failure: "truncated",
      failure_kind: "truncated",
      format: "elf",
      offset: 4,
      available_bytes: 4,
      required_bytes: 64,
    });
  });

  it("lists every input of a conflict and blames none", () => {
    expect(targetFailureDetails(failureOf("conflict"))).toMatchObject({
      failure_kind: "conflict",
      inputs: [
        { field: "path", path: "/tmp/a" },
        { field: "binary_path", path: "/tmp/b" },
      ],
    });
  });

  it("gives each caller action its own recovery", () => {
    const malformed = targetFailureRecovery("op", failureOf("malformed"));
    const truncated = targetFailureRecovery("op", failureOf("truncated"));
    expect(malformed).toContain("request arguments are not at fault");
    expect(truncated).toContain("Re-acquire the complete file");
    expect(truncated).not.toBe(malformed);
  });
});
