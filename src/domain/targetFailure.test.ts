import { describe, expect, it } from "vitest";

import { AnalysisTargetFailureError } from "./analysisErrorCore.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import { analysisErrorProjectionSchema } from "./analysisErrorProjectionSchema.js";
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
      return {
        ...facts,
        kind,
        extent: { availableBytes: 4, requiredBytes: 64 },
      };
    case "conflict":
      return {
        ...facts,
        kind,
        inputs: [
          { field: "path", path: "/tmp/a" },
          { field: "binary_path", path: "/tmp/b" },
        ],
      };
    case "io":
      return { ...facts, kind, transient: false };
    default:
      return { ...facts, kind };
  }
};

const project = (failure: TargetFailure) =>
  projectAnalysisError(
    new AnalysisTargetFailureError("inspect_elf_notes", "/tmp/t", failure),
  );

describe("target failure projection", () => {
  it.each(TARGET_FAILURE_KINDS)(
    "derives the public contract of %s from its kind",
    (kind) => {
      const { code, category, retry } = TARGET_FAILURE_CONTRACT[kind];
      const failure = failureOf(kind);
      const projected = project(failure);
      expect(projected).toMatchObject({
        code,
        category,
        retry,
        // `retryable` keeps its contract meaning: the unchanged request may succeed.
        retryable: retry === "backoff",
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
      expect(projected).not.toHaveProperty("details.format_failure");
      // Every kind's projection satisfies the schema CLI and MCP advertise.
      expect(analysisErrorProjectionSchema.safeParse(projected).success).toBe(
        true,
      );
    },
  );

  it("gives no two kinds with unrelated caller actions one code", () => {
    const actions = new Map<string, Set<string>>();
    for (const kind of TARGET_FAILURE_KINDS) {
      const { code } = TARGET_FAILURE_CONTRACT[kind];
      actions.set(code, (actions.get(code) ?? new Set()).add(kind));
    }
    // Only the four target refusals share a code; `failure_kind` says which.
    expect(
      [...actions.values()]
        .filter((kinds) => kinds.size > 1)
        .map((k) => [...k]),
    ).toEqual([["unrecognized", "unsupported", "malformed", "truncated"]]);
  });

  it("refines an io failure's retry hint from its errno fact", () => {
    expect(project(failureOf("io"))).toMatchObject({
      retry: "none",
      retryable: false,
    });
    expect(
      project({ ...failureOf("io"), kind: "io", transient: true }),
    ).toMatchObject({ retry: "backoff", retryable: true });
  });

  it("reports measured extents for a truncated structure", () => {
    expect(targetFailureDetails(failureOf("truncated"))).toEqual({
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
