import { expect, it } from "vitest";

import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { translateArtifactFailure } from "./ArtifactOperationFailure.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { artifactReaderLimitFailure } from "./ArtifactReaderLimits.js";
import { constants as bufferConstants } from "node:buffer";

it.each([
  { effective: 1, required: bufferConstants.MAX_STRING_LENGTH + 1 },
  { effective: bufferConstants.MAX_STRING_LENGTH, required: undefined },
])(
  "does not recommend a larger budget when no supported increase can repair it: %o",
  ({ effective, required }) => {
    const failure = artifactReaderLimitFailure(
      "artifact_limits.godot.directory_bytes",
      effective,
      "bytes",
      required,
    );
    const projected = projectAnalysisError(
      translateArtifactFailure("inspect_artifact", failure),
    );
    expect(projected).toMatchObject({
      retryable: false,
      details: {
        reader_limit: {
          can_increase: false,
          maximum: bufferConstants.MAX_STRING_LENGTH,
        },
      },
    });
    expect(projected.remediation.action).toContain("No supported increase");
  },
);

it("preserves adjustable reader admission facts and gives cleanup priority", () => {
  const failure = artifactReaderLimitFailure(
    "artifact_limits.node_sea.argument_count",
    1,
    "count",
    2,
  );
  const adjustable = projectAnalysisError(
    translateArtifactFailure("inspect_artifact", failure),
  );
  expect(adjustable).toMatchObject({
    code: "truncated",
    retryable: true,
    details: {
      reader_limit: {
        parameter: "artifact_limits.node_sea.argument_count",
        effective_value: 1,
        required_value: 2,
        unit: "count",
        applies_at: "next_operation",
        update_mode: "parameter",
        pending_restart: false,
      },
    },
  });
  expect(adjustable.remediation.action).toContain(
    "retry the same complete artifact",
  );
  const wrapped = ArtifactReaderFailure.withCleanup(failure, {
    reason: "Reader descriptor release failed",
    resources: ["owned input descriptor"],
  });
  const projected = projectAnalysisError(
    translateArtifactFailure("inspect_artifact", wrapped),
  );
  expect(projected.retryable).toBe(false);
  expect(projected.details).toMatchObject({
    reader_limit: adjustable.details?.reader_limit,
    cleanup: "incomplete",
    resources: ["owned input descriptor"],
  });
});

it.each(["capacity", "file-size", "memory"] as const)(
  "retains the producing %s limit through public error projection",
  (boundary) => {
    const failure = new ArtifactReaderFailure(
      "limit",
      "The specific reader allowance was exceeded",
      { boundary },
    );
    const result = projectAnalysisError(
      translateArtifactFailure("inventory_artifact", failure),
    );
    expect(result).toMatchObject({
      code: "truncated",
      retryable: false,
      message: failure.message,
      details: { boundary, detail: failure.message },
    });
  },
);

it("keeps producer-owned recovery through cleanup wrapping and public projection", () => {
  const userMessage = "Caller-selected reader recovery";
  const failure = new ArtifactReaderFailure(
    "unavailable",
    "Exact command diagnostic",
    {
      userMessage,
    },
  );
  const wrapped = ArtifactReaderFailure.withCleanup(failure, {
    reason: "Owned staging cleanup needs retry",
    resources: ["owned staging"],
  });
  const projected = projectAnalysisError(
    translateArtifactFailure("inspect_artifact", wrapped),
  );
  expect(projected.message).toBe(userMessage);
  expect(projected.remediation.action).toBe(userMessage);
  expect(projected.details?.detail).toBe("Exact command diagnostic");
  expect(projected.details).toMatchObject({
    cleanup: "incomplete",
    cleanup_reason: "Owned staging cleanup needs retry",
    resources: ["owned staging"],
  });
});
