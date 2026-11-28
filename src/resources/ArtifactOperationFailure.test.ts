import { expect, it, onTestFinished, vi } from "vitest";
import { ZstandardFrameAllowanceError } from "../domain/compression/zstandardFrameAllowance.js";
import {
  MAXIMUM_ZSTD_MAX_FRAMES,
  MINIMUM_ZSTD_MAX_FRAMES,
} from "../domain/analysisResourceLimits.js";
import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { sep } from "node:path";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

import {
  ArtifactReaderFailure,
  artifactFixedLimitFailure,
  artifactFormatFailure,
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
  artifactFilePrimaryFacts,
  artifactParseFailure,
  withArtifactFileHandle,
} from "./ArtifactFileOperation.js";
import { ArtifactResourceScope } from "./ArtifactResourceScope.js";
import { artifactFileAdmissionFailure } from "./ArtifactFileAdmission.js";
import { NonRegularFileReadError } from "../filesystem/RegularFile.js";
import { artifactReaderLimitFailure } from "./index.js";
import { targetDigestChangedFailure } from "./withArtifactTargetIdentity.js";
import {
  malformedInput,
  ParseFailureError,
  truncatedInput,
  unrecognizedInput,
  unsupportedInput,
} from "../domain/parseFailure.js";
import {
  FORMAT_TARGET_FAILURE_KINDS,
  type FormatTargetFailure,
} from "../domain/targetFailure.js";
import { AnalysisTargetFailureError } from "../domain/analysisErrorCore.js";

it("projects a Zstandard frame-cap as an adjustable artifact limit", () => {
  expect(
    translateArtifactFailure(
      "extract_artifact",
      "/selected/artifact",
      new ZstandardFrameAllowanceError({ maxFrames: 4, source: "runtime" }, 10),
    ),
  ).toMatchObject({
    _tag: "AnalysisResourceConstraintError",
    resource: "cpu",
    limit: {
      setting: "zstd.max_frames",
      effective_value: 4,
      source: "runtime",
      minimum: MINIMUM_ZSTD_MAX_FRAMES,
      maximum: MAXIMUM_ZSTD_MAX_FRAMES,
      unit: "count",
    },
  });
});

const failWithDescriptorCleanup = async (
  bytes: Buffer,
  failure: unknown,
  retryFailure?: Error,
) => {
  const root = await createTestTempDirectory("rea-artifact-projection-");
  const path = `${root}${sep}.${sep}artifact`;
  await writeFile(path, bytes);
  const descriptor = await open(path);
  const nativeClose = descriptor.close.bind(descriptor);
  onTestFinished(async () => {
    if (descriptor.fd >= 0) await nativeClose();
  });
  const close = vi
    .spyOn(descriptor, "close")
    .mockRejectedValueOnce(new Error("close failed"));
  if (retryFailure !== undefined) close.mockRejectedValueOnce(retryFailure);
  const scope = new ArtifactResourceScope();
  const wrapped = await withArtifactFileHandle(
    path,
    descriptor,
    scope,
    undefined,
    async () => {
      throw failure;
    },
  ).then(
    () => {
      throw new Error("Expected artifact operation and close failures");
    },
    (cause: unknown) => cause,
  );
  return { path, scope, descriptor, wrapped };
};

it.each([
  { cause: malformedInput("pe", "bad field") },
  { cause: truncatedInput("pe", "short field") },
  { cause: unsupportedInput("pe", "unsupported image") },
  { cause: unrecognizedInput("pe", "not a PE image") },
])(
  "preserves $cause.kind projection and selected identity through descriptor cleanup",
  async ({ cause }) => {
    const operation = "inspect_pe_resources";
    const bytes = Buffer.from("inert snapshot");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const failure = artifactParseFailure(cause, undefined);
    expect(failure).toMatchObject({ cause });
    const { path, scope, descriptor, wrapped } =
      await failWithDescriptorCleanup(
        bytes,
        failure,
        new Error("cleanup retry failed"),
      );
    const primary = projectOwnedArtifactInputFailure(
      artifactFilePrimaryFacts(wrapped),
      operation,
      path,
    );
    if (primary === undefined)
      throw new Error("Expected a selected-input projection");
    expect(primary.cause).toBe(failure);
    const selected = projectStableArtifactFailure(
      wrapped,
      primary,
      path,
      "pe-fixture",
      operation,
      { bytes, sha256 },
    );
    const generic = translateArtifactFailure("inspect_artifact", path, wrapped);
    const observation = {
      kind: "file-snapshot-hash",
      path,
      sha256,
      bytes: bytes.length,
    };
    const expectPending = () => {
      expect(projectAnalysisError(selected)).toMatchObject({
        code: "cleanup_incomplete",
        details: { resources: [path], partial_observation: observation },
      });
      expect(projectAnalysisError(generic)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          reason: cause.message,
          cleanup: "incomplete",
          resources: [path],
        },
      });
    };

    expectPending();
    await expect(scope.retryCleanup()).rejects.toMatchObject({
      cleanup: { reason: "cleanup retry failed", resources: [path] },
    });
    expect(descriptor.fd).toBeGreaterThanOrEqual(0);
    expectPending();
    await scope.close();
    expect(descriptor.fd).toBe(-1);
    // Malformed, truncated and unsupported bytes are all target refusals.
    expect(projectAnalysisError(selected)).toMatchObject({
      code: "unsupported_target",
      category: "unsupported_target",
      details: {
        operation,
        path,
        reason: cause.message,
        failure_kind: cause.kind,
        format: "pe",
        partial_observation: observation,
      },
    });
    // An inventory refusal of the same bytes is the same target failure of
    // the selected path, with the format owner's facts.
    expect(projectAnalysisError(generic)).toMatchObject({
      code: "unsupported_target",
      category: "unsupported_target",
      retry: "none",
      details: {
        operation: "inspect_artifact",
        path,
        reason: cause.message,
        failure_kind: cause.kind,
        format: "pe",
      },
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
      translateArtifactFailure(
        "inspect_artifact",
        "/selected/artifact",
        failure,
      ),
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
    translateArtifactFailure("inspect_artifact", "/selected/artifact", failure),
  );
  expect(adjustable).toMatchObject({
    code: "partial",
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
    translateArtifactFailure("inspect_artifact", "/selected/artifact", wrapped),
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
      translateArtifactFailure(
        "inventory_artifact",
        "/selected/artifact",
        failure,
      ),
    );
    expect(result).toMatchObject({
      code: "partial",
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
        translateArtifactFailure(
          "inventory_artifact",
          "/selected/artifact",
          wrapped,
        ),
      ),
    ).toMatchObject({
      code: "cleanup_incomplete",
      details: { boundary, cleanup: "incomplete", resources: ["handle"] },
    });
  },
);

it("reports a parser limit even when artifact cleanup also fails", () => {
  const failure = new ArtifactReaderFailure("limit", "Plist decode limit", {
    parserLimit: { name: "plist-decode-bytes", maximum: 512 },
  });
  const wrapped = ArtifactReaderFailure.withCleanup(failure, {
    reason: "close failed",
    resources: ["handle"],
  });
  expect(
    projectAnalysisError(
      translateArtifactFailure(
        "inspect_keyed_archive",
        "/selected/artifact",
        wrapped,
      ),
    ),
  ).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      reason: "limit",
      reported_limits: { boundary: "plist-decode-bytes", maximum: 512 },
      cleanup: "incomplete",
      resources: ["handle"],
    },
  });
});

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
    projectAnalysisError(
      translateArtifactFailure(
        "inspect_artifact",
        "/selected/artifact",
        failure,
      ),
    ),
  ).toMatchObject({
    code: "partial",
    retryable: false,
    message: failure.message,
    details: { refusal },
  });
  const wrapped = ArtifactReaderFailure.withCleanup(failure, {
    reason: "close failed",
    resources: ["handle"],
  });
  const projected = projectAnalysisError(
    translateArtifactFailure("inspect_artifact", "/selected/artifact", wrapped),
  );
  expect(projected).toMatchObject({
    code: "cleanup_incomplete",
    retryable: false,
    details: { refusal, cleanup: "incomplete", resources: ["handle"] },
  });
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
    translateArtifactFailure("inspect_artifact", "/selected/artifact", wrapped),
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

it("projects a session digest mismatch as admitted identity, not a retryable change", () => {
  const projected = projectAnalysisError(
    translateArtifactFailure(
      "inspect_keyed_archive",
      "/selected/archive",
      targetDigestChangedFailure("archive", "a".repeat(64), "b".repeat(64)),
    ),
  );
  expect(projected).toMatchObject({
    code: "artifact_operation_failed",
    category: "integrity_mismatch",
    retryable: false,
    details: {
      reason: "integrity",
      integrity_check: "admitted-identity",
    },
  });
  expect(projected.retry).toBeUndefined();
});

it("names the failed integrity check through cleanup wrapping and public projection", () => {
  const failure = new ArtifactReaderFailure(
    "integrity",
    "ASAR container changed before read: main.js",
    { integrityCheck: "container-identity" },
  );
  expect(
    projectAnalysisError(
      translateArtifactFailure(
        "inventory_artifact",
        "/selected/artifact",
        failure,
      ),
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
      translateArtifactFailure(
        "inventory_artifact",
        "/selected/artifact",
        wrapped,
      ),
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
      translateArtifactFailure(
        "extract_artifact",
        "/selected/artifact",
        unpacked,
      ),
    ),
  ).toMatchObject({
    details: {
      logical_path: "main.js",
      unpacked: true,
      integrity_check: "unpacked-entry-identity",
    },
  });
});

it("keeps the named integrity check through descriptor cleanup", async () => {
  const { path, scope, wrapped } = await failWithDescriptorCleanup(
    Buffer.from("fixture"),
    new ArtifactReaderFailure(
      "integrity",
      "ASAR read coverage was short: main.js",
      {
        integrityCheck: "read-coverage",
      },
    ),
  );
  expect(
    projectAnalysisError(
      translateArtifactFailure(
        "extract_artifact",
        "/selected/artifact",
        wrapped,
      ),
    ),
  ).toMatchObject({
    code: "cleanup_incomplete",
    details: { integrity_check: "read-coverage", resources: [path] },
  });
  await scope.close();
});

// A changed check is retryable after backoff; any other check, such as a
// session target that no longer matches its admitted digest, fails the same
// way on an unchanged retry and keeps the reader's reopen recovery.
it("reports a reader integrity failure as changed only for a changed check", () => {
  const failure = new ArtifactReaderFailure("integrity", "container moved", {
    integrityCheck: "container-identity",
  });
  const wrapper = new Error("cleanup wrapper", { cause: failure });
  const capturedOutput = { stdout: "out", stderr: "", truncated: false };
  const changed = readerIntegrityFailure("inspect_gpu", "/target", failure, {
    cause: wrapper,
    capturedOutput,
  });
  expect(changed).toMatchObject({ cause: wrapper, capturedOutput });
  expect(projectAnalysisError(changed)).toMatchObject({
    code: "artifact_changed",
    retryable: true,
    retry: "backoff",
    message: expect.stringContaining("changed during acquisition"),
    details: {
      path: "/target",
      boundary: "stable-artifact-read",
      integrity_check: "container-identity",
    },
  });

  const stale = projectAnalysisError(
    readerIntegrityFailure(
      "inspect_plist",
      "/bundle/Info.plist",
      targetDigestChangedFailure("target", "a".repeat(64), "b".repeat(64)),
      { capturedOutput },
    ),
  );
  expect(stale).toMatchObject({
    code: "artifact_operation_failed",
    category: "integrity_mismatch",
    retryable: false,
    message: expect.stringContaining(
      "Reopen the selected artifact, then retry.",
    ),
    remediation: {
      action: expect.stringContaining(
        "Reopen the selected artifact, then retry.",
      ),
    },
    details: {
      operation: "inspect_plist",
      reason: "integrity",
      integrity_check: "admitted-identity",
    },
  });
  expect(stale.retry).toBeUndefined();
});

// A reader's target reasons mean the bytes; only `path` names the
// caller's selection. A non-regular source is a path-kind refusal at its owner.
it("keeps only a path-kind reader refusal a selection error", () => {
  const operation = "inspect_erlang_beam";
  const path = "/artifacts/app.beam";
  const nonRegular = artifactFileAdmissionFailure(
    path,
    "BEAM",
    new NonRegularFileReadError(path, true),
  );
  expect(nonRegular.reason).toBe("path");
  expect(
    projectAnalysisError(
      projectOwnedArtifactInputFailure(
        artifactFilePrimaryFacts(nonRegular),
        operation,
        path,
      )!,
    ),
  ).toMatchObject({
    code: "invalid_request",
    details: {
      operation,
      issues: [{ path: ["path"], reason: "invalid_format" }],
    },
  });
});

/** One owner failure of each format kind, with every shared fact set. */
const formatFailure = (
  kind: (typeof FORMAT_TARGET_FAILURE_KINDS)[number],
): FormatTargetFailure => {
  const facts = {
    format: "macho",
    detail: `${kind} bytes`,
    offset: 4,
    field: "magic",
  };
  switch (kind) {
    case "unsupported":
      return { kind, ...facts, undecodedContent: false };
    case "truncated":
      return {
        kind,
        ...facts,
        extent: { availableBytes: 4, requiredBytes: 32 },
      };
    case "unrecognized":
    case "malformed":
      return { kind, ...facts };
  }
};

it.each(FORMAT_TARGET_FAILURE_KINDS)(
  "keeps a %s owner failure and its facts through both artifact wrappers",
  (kind) => {
    const failure = formatFailure(kind);
    for (const wrapped of [
      artifactParseFailure(new ParseFailureError(failure), undefined),
      artifactFormatFailure(failure),
    ]) {
      expect(wrapped).toBeInstanceOf(ArtifactReaderFailure);
      expect((wrapped as ArtifactReaderFailure).parseFailure).toEqual(failure);
      const projected = translateArtifactFailure(
        "inspect_artifact",
        "/selected/artifact",
        wrapped,
      );
      expect(projected).toBeInstanceOf(AnalysisTargetFailureError);
      expect((projected as AnalysisTargetFailureError).failure).toEqual(
        failure,
      );
    }
  },
);
