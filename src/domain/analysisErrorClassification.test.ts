import { expect, it } from "vitest";
import { isAnalysisErrorTag } from "./analysisErrorBase.js";
import { analysisErrorCatalogue } from "./analysisErrorClassification.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import { ArtifactOperationError } from "./artifactOperationError.js";
import { BinaryTargetError } from "./configurationErrors.js";
import { EvidenceFileError } from "./evidenceErrors.js";
import {
  capacityConstraint,
  fixedCeilingConstraint,
} from "./analysisErrorCore.js";

const catalogue = analysisErrorCatalogue();
it("keeps occupied capacity recovery distinct from a fixed transport ceiling", () => {
  const capacity = capacityConstraint("inspect_adb_ui", "runner occupied", {
    remediationAction:
      "Let the admitted request settle, then inspect current state.",
    diagnostics: { runner_instance: "selected-runner" },
  });
  expect(capacity).toMatchObject({
    resource: "capacity",
    reportedLimits: null,
    diagnostics: { runner_instance: "selected-runner" },
  });
  expect(capacity.fixedAllowance).toBeUndefined();
  expect(projectAnalysisError(capacity)).toMatchObject({
    code: "resource_constraint",
    retryable: true,
  });
  const ceiling = fixedCeilingConstraint(
    "inspect_adb_ui",
    "transport",
    "request too large",
    {
      name: "ADB UI request",
      kind: "bytes",
      limit: 16384,
      unit: "bytes",
    },
  );
  expect(ceiling.fixedAllowance).toMatchObject({ limit: 16384, unit: "bytes" });
  expect(projectAnalysisError(ceiling)).toMatchObject({
    code: "resource_constraint",
    retryable: false,
  });
});
const entry = (tag: string, discriminant: string) =>
  catalogue.find((row) => row.tag === tag && row.discriminant === discriminant);

it("lists each domain error case once", () => {
  const keys = catalogue.map((row) => `${row.tag}|${row.discriminant}`);
  expect(new Set(keys).size).toBe(keys.length);
  for (const row of catalogue) expect(isAnalysisErrorTag(row.tag)).toBe(true);
});

it.each([
  "not-file",
  "exists",
  "wrong-kind",
  "invalid-json",
  "missing",
  "path-limit",
  "storage-limit",
  "symlink-traversal",
  "io",
] as const)(
  "reports an evidence file %s failure as its catalogue row",
  (reason) => {
    const projected = projectAnalysisError(
      new EvidenceFileError("read", reason),
    );
    expect(entry("EvidenceFileError", `reason=${reason}`)).toMatchObject({
      code: projected.code,
      category: projected.category,
      retryableByDefault: projected.retryable,
    });
  },
);

it.each([
  "cancelled",
  "malformed",
  "truncated",
  "unsupported",
  "format",
  "integrity",
  "path",
  "unavailable",
  "io",
] as const)(
  "reports an artifact operation %s failure as its catalogue row",
  (reason) => {
    const projected = projectAnalysisError(
      new ArtifactOperationError("inspect_artifact", reason),
    );
    expect(entry("ArtifactOperationError", `reason=${reason}`)).toMatchObject({
      code: projected.code,
      category: projected.category,
    });
  },
);

it("keeps a refused target's constraint category beside its permission code", () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  const projected = projectAnalysisError(
    new BinaryTargetError("/target", "refused", {
      constraint: "file_format_rejected",
      cause: denied,
    }),
  );
  expect(projected).toMatchObject({
    code: "access_denied",
    category: "unsupported_target",
  });
  expect(
    entry(
      "BinaryTargetError",
      "constraint=file_format_rejected; read permission denied",
    ),
  ).toMatchObject({ code: projected.code, category: projected.category });
});

it("reports a budget-exceeded bundle target as its catalogue row", () => {
  const projected = projectAnalysisError(
    new BinaryTargetError("/target", "refused", {
      constraint: "bundle_info_plist_decode_budget_exceeded",
    }),
  );
  expect(projected).toMatchObject({
    code: "target_unavailable",
    category: "unavailable",
  });
  expect(
    entry(
      "BinaryTargetError",
      "constraint=bundle_info_plist_decode_budget_exceeded",
    ),
  ).toMatchObject({ code: projected.code, category: projected.category });
  const denied = projectAnalysisError(
    new BinaryTargetError("/target", "refused", {
      constraint: "bundle_info_plist_decode_budget_exceeded",
      cause: Object.assign(new Error("denied"), { code: "EACCES" }),
    }),
  );
  expect(denied).toMatchObject({
    code: "access_denied",
    category: "unavailable",
  });
  expect(
    entry(
      "BinaryTargetError",
      "constraint=bundle_info_plist_decode_budget_exceeded; read permission denied",
    ),
  ).toMatchObject({ code: denied.code, category: denied.category });
});
