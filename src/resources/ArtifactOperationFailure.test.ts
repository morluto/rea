import { expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  ArtifactReaderFailure,
  artifactFixedLimitFailure,
} from "./ArtifactReader.js";
import { translateArtifactFailure } from "./ArtifactOperationFailure.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { constants as bufferConstants } from "node:buffer";
import {
  imageFileSizeRemediation,
  projectOwnedArtifactInputFailure,
  projectStableArtifactFailure,
  readerIntegrityFailure,
} from "./StableArtifactFailure.js";
import { artifactIntegrityDetails } from "../domain/artifactIntegrity.js";
import {
  ArtifactFileCleanupFailure,
  artifactFilePrimaryFacts,
  artifactParseFailure,
} from "./ArtifactFileOperation.js";
import { AnalysisCleanupLease } from "./AnalysisCleanupLease.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";
import { artifactReaderLimitFailure } from "./index.js";
import {
  malformedInput,
  truncatedInput,
  unsupportedInput,
} from "../domain/parseFailure.js";

it.each([
  malformedInput("pe", "bad field"),
  truncatedInput("pe", "short field"),
  unsupportedInput("pe", "unsupported image"),
])(
  "preserves selected input projection and partial identity through cleanup retry: $kind",
  async (cause) => {
    const path = "/selected/./program.exe";
    const operation = "inspect_pe_resources";
    const failure = artifactParseFailure(cause, undefined);
    expect(failure).toMatchObject({ cause });
    let attempts = 0;
    const lease = new AnalysisCleanupLease(async () => {
      if (attempts++ === 0) throw new Error("cleanup retry failed");
    }, [path]);
    const wrapped = new ArtifactFileCleanupFailure(
      new RegularFileCleanupFailure({
        path,
        owner: { close: async () => undefined } as never,
        outcome: { kind: "failed", cause: failure },
        cleanupCause: new Error("close failed"),
      }),
      lease,
    );
    const primary = projectOwnedArtifactInputFailure(
      artifactFilePrimaryFacts(wrapped),
      operation,
      path,
    );
    if (primary === undefined)
      throw new Error("Expected a selected-input projection");
    expect(primary.cause).toBe(failure);
    const bytes = Buffer.from("inert snapshot");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const projected = projectStableArtifactFailure(
      wrapped,
      primary,
      path,
      "pe-fixture",
      operation,
      { bytes, sha256 },
    );
    expect(projectAnalysisError(projected)).toMatchObject({
      code: "cleanup_incomplete",
    });
    await expect(lease.release()).rejects.toThrow("cleanup retry failed");
    expect(projectAnalysisError(projected)).toMatchObject({
      code: "cleanup_incomplete",
    });
    await lease.release();
    expect(projectAnalysisError(projected)).toMatchObject({
      code:
        cause.kind === "unsupported" ? "unsupported_target" : "invalid_request",
      details:
        cause.kind === "unsupported"
          ? { operation, path, reason: cause.message }
          : {
              operation,
              issues: [
                {
                  path: ["path"],
                  reason: "invalid_format",
                  message: cause.message,
                },
              ],
            },
    });
    expect(projected.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path,
      sha256,
      bytes: bytes.length,
    });
  },
);

it("leaves opaque operation errors and decode limits with their owning projection", () => {
  const unsupported = artifactParseFailure(
    unsupportedInput("pe", "unsupported"),
    undefined,
  );
  expect(
    projectOwnedArtifactInputFailure(
      { cause: unsupported, origin: "opaque-operation" },
      "inspect_pe_resources",
      "/selected.exe",
    ),
  ).toBeUndefined();
  expect(
    projectOwnedArtifactInputFailure(
      {
        cause: new ArtifactReaderFailure("limit", "budget"),
        origin: "owned-or-classified",
      },
      "inspect_pe_resources",
      "/selected.exe",
    ),
  ).toBeUndefined();
});

it.each([
  {
    cause: malformedInput("fixture", "bad field"),
    code: "invalid_request",
    category: "invalid_input",
  },
  {
    cause: truncatedInput("fixture", "short field"),
    code: "truncated",
    category: "truncated",
  },
  {
    cause: unsupportedInput("fixture", "new revision"),
    code: "unsupported_target",
    category: "unsupported_target",
  },
])(
  "preserves $cause.kind parser facts after cleanup retry",
  async ({ cause, code, category }) => {
    const readerFailure = artifactParseFailure(cause, undefined);
    if (!(readerFailure instanceof ArtifactReaderFailure))
      throw new Error(
        "Parser failure did not become an artifact reader failure",
      );
    expect(readerFailure).toMatchObject({ reason: cause.kind, cause });
    const lease = new AnalysisCleanupLease(async () => {}, [
      "fixture descriptor",
    ]);
    const wrapped = ArtifactReaderFailure.withCleanup(
      readerFailure,
      { reason: "close failed", resources: ["fixture descriptor"] },
      undefined,
      [lease],
    );
    const projectedOwner = translateArtifactFailure(
      "inspect_artifact",
      wrapped,
    );
    expect(projectAnalysisError(projectedOwner)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        reason: cause.kind,
        detail: cause.message,
        cleanup: "incomplete",
      },
    });
    await lease.release();
    expect(projectAnalysisError(projectedOwner)).toMatchObject({
      code,
      category,
      details: { reason: cause.kind, detail: cause.message },
    });
  },
);

// The provider ceiling test uses a sparse file and is skipped on Windows.
it.skipIf(process.platform !== "win32")(
  "names the fixed image ceiling when the selected budget is already maximal",
  () => {
    expect(imageFileSizeRemediation(1024, 1024)).toContain(
      "no runtime override",
    );
  },
);

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
    const wrapped = ArtifactReaderFailure.withCleanup(failure, {
      reason: "close failed",
      resources: ["handle"],
    });
    expect(
      projectAnalysisError(
        translateArtifactFailure("inventory_artifact", wrapped),
      ),
    ).toMatchObject({
      code: "cleanup_incomplete",
      details: { boundary, cleanup: "incomplete", resources: ["handle"] },
    });
  },
);

it("keeps a fixed reader ceiling's refusal through cleanup wrapping and public projection", () => {
  const failure = artifactFixedLimitFailure(
    {
      name: "The fixture table allowance",
      kind: "parser",
      limit: 64,
      unit: "records",
    },
    "The fixture table declares 65 records, above 64.",
  );
  const refusal = {
    kind: "fixed_ceiling",
    allowance: "The fixture table allowance",
    allowance_kind: "parser",
    limit: 64,
    unit: "records",
  };
  expect(
    projectAnalysisError(translateArtifactFailure("inspect_artifact", failure)),
  ).toMatchObject({
    code: "truncated",
    retryable: false,
    message: failure.message,
    details: { refusal },
  });
  const wrapped = ArtifactReaderFailure.withCleanup(failure, {
    reason: "close failed",
    resources: ["handle"],
  });
  expect(wrapped.fixedAllowance).toBe(failure.fixedAllowance);
  const projected = projectAnalysisError(
    translateArtifactFailure("inspect_artifact", wrapped),
  );
  expect(projected).toMatchObject({
    code: "cleanup_incomplete",
    retryable: false,
    details: { refusal, cleanup: "incomplete", resources: ["handle"] },
  });
  expect(projected.remediation.action).toContain("The allowance is 64 records");
});

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

it("names the failed integrity check through cleanup wrapping and public projection", () => {
  const failure = new ArtifactReaderFailure(
    "integrity",
    "ASAR container changed before read: main.js",
    { integrityCheck: "container-identity" },
  );
  expect(
    projectAnalysisError(
      translateArtifactFailure("inventory_artifact", failure),
    ),
  ).toMatchObject({
    details: { reason: "integrity", integrity_check: "container-identity" },
  });
  const wrapped = ArtifactReaderFailure.withCleanup(failure, {
    reason: "close failed",
    resources: ["handle"],
  });
  expect(
    projectAnalysisError(
      translateArtifactFailure("inventory_artifact", wrapped),
    ),
  ).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      integrity_check: "container-identity",
      cleanup: "incomplete",
      resources: ["handle"],
    },
  });

  const unpacked = new ArtifactReaderFailure(
    "integrity",
    "ASAR unpacked entry changed before read: main.js",
    { integrityCheck: "unpacked-entry-identity" },
    artifactIntegrityDetails("main.js", null, null, true),
  );
  expect(
    projectAnalysisError(
      translateArtifactFailure("extract_artifact", unpacked),
    ),
  ).toMatchObject({
    details: {
      logical_path: "main.js",
      unpacked: true,
      integrity_check: "unpacked-entry-identity",
    },
  });
});

it("keeps the named integrity check when a descriptor close failure rebuilds the reader failure", () => {
  const failure = new ArtifactFileCleanupFailure(
    new RegularFileCleanupFailure({
      path: "/artifact.asar",
      owner: { close: async () => undefined } as never,
      outcome: {
        kind: "failed",
        cause: new ArtifactReaderFailure(
          "integrity",
          "ASAR read coverage was short: main.js",
          { integrityCheck: "read-coverage" },
        ),
      },
      cleanupCause: new Error("close failed"),
    }),
    new AnalysisCleanupLease(async () => undefined),
  );
  expect(failure.integrityCheck).toBe("read-coverage");
  expect(
    projectAnalysisError(translateArtifactFailure("extract_artifact", failure)),
  ).toMatchObject({
    code: "cleanup_incomplete",
    details: { integrity_check: "read-coverage", cleanup: "incomplete" },
  });
});

it("keeps a reader's named check when a provider supplies its own cause and options", () => {
  const failure = new ArtifactReaderFailure("integrity", "region changed", {
    integrityCheck: "reconstruction",
  });
  const wrapper = new Error("cleanup wrapper", { cause: failure });
  const capturedOutput = { stdout: "out", stderr: "", truncated: false };
  const changed = readerIntegrityFailure("inspect_gpu", "/target", failure, {
    cause: wrapper,
    capturedOutput,
  });
  expect(changed).toMatchObject({
    cause: wrapper,
    capturedOutput,
    reason: "region changed",
    integrityCheck: "reconstruction",
  });
  expect(projectAnalysisError(changed)).toMatchObject({
    code: "artifact_changed",
    details: { integrity_check: "reconstruction" },
  });
});
