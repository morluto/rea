import { AnalysisAccessDeniedError } from "./analysisErrorCore.js";
import { expect, it } from "vitest";
import {
  AnalysisInputError,
  AnalysisCapabilityUnavailableError,
  AnalysisCancelledError,
  AnalysisTimeoutError,
  AnalysisArtifactChangedError,
  AnalysisOutputError,
  AnalysisResourceConstraintError,
} from "./analysisErrorCore.js";
import { projectAnalysisError } from "./analysisErrorProjection.js";
import { ProviderCleanupError } from "./providerCleanupError.js";
import { ProviderAdapterError } from "./providerAdapterError.js";
import {
  redactExplicitFailure,
  redactExplicitPointer,
} from "./explicitSensitiveFailure.js";

const context = {
  diagnostics: {
    note: "explicit-secret warning",
    nested: { "explicit-secret-key": 5, observed: 7 },
    caller_path: "/tmp/password-fixture?token=public-value",
  },
  capturedOutput: {
    stdout: "explicit-secret output",
    stderr: "public stderr",
    stdout_bytes: 22,
    truncated: false,
  },
};

it.each([
  new AnalysisCancelledError("inspect", context),
  new AnalysisTimeoutError("inspect", 250, context),
  new AnalysisInputError("inspect", context),
  new AnalysisAccessDeniedError("inspect", "/public", "EACCES", context),
  new AnalysisArtifactChangedError("inspect", "/public", "changed", context),
  new AnalysisOutputError("inspect", "invalid", context),
  new AnalysisCapabilityUnavailableError(
    "provider",
    "inspect",
    "unsupported",
    context,
  ),
  new AnalysisResourceConstraintError(
    "inspect",
    "memory",
    "capacity",
    null,
    context,
  ),
  new ProviderAdapterError("provider", "inspect", context),
])("preserves sanitized common context for $._tag", (error) => {
  const sanitized = redactExplicitFailure(error, ["explicit-secret"]);
  expect(sanitized._tag).toBe(error._tag);
  const projected = projectAnalysisError(sanitized);
  expect(projected.details).toMatchObject({
    diagnostics: {
      note: "[REDACTED] warning",
      nested: { observed: 7 },
      caller_path: context.diagnostics.caller_path,
    },
    captured_output: {
      stdout: "[REDACTED] output",
      stdout_bytes: 22,
      stderr: "public stderr",
    },
  });
  expect(JSON.stringify(projected)).not.toContain("explicit-secret");
});

it.each([
  ["/metadata/private~1~0/numeric", ["private/~"], "/metadata"],
  ["/metadata/private/child", ["private"], "/metadata"],
  ["/ordinary/path", [], "/ordinary/path"],
])(
  "preserves a real parent for excluded pointer identities: %s",
  (pointer, values, expected) => {
    expect(redactExplicitPointer(pointer, values)).toBe(expected);
  },
);

it("preserves cleanup failure authority and resources while excluding diagnostics", () => {
  const error = new ProviderCleanupError(
    "har",
    ["/root/private/capture", "pid:123"],
    {
      capture_path: "/root/private/capture",
      nested: { "private-key": 5, ordinary: "private ordinary" },
      exit_code: 2,
    },
    { operation: "inspect_web_network_capture" },
  );
  const projected = projectAnalysisError(
    redactExplicitFailure(error, ["private", "REDACTED"]),
  );
  expect(projected.code).toBe("cleanup_incomplete");
  expect(JSON.stringify(projected)).not.toContain("private");
  expect(JSON.stringify(projected)).not.toContain("REDACTED");
  expect(JSON.stringify(projected)).toContain("pid:123");
  expect(JSON.stringify(projected)).toContain('"exit_code":2');
});

it("keeps unsupported profile reasons distinct from malformed input", () => {
  const error = new AnalysisCapabilityUnavailableError(
    "mitmproxy",
    "inspect_web_network_capture",
    "Unsupported private profile",
    { userMessage: "Select private-compatible profile" },
  );
  const result = redactExplicitFailure(error, ["private"]);
  expect(result).toBeInstanceOf(AnalysisCapabilityUnavailableError);
  expect(projectAnalysisError(result).code).toBe("capability_unavailable");
  expect(JSON.stringify(projectAnalysisError(result))).not.toContain("private");
});

it("preserves a retryable capability failure through explicit-value redaction", () => {
  // Retryability is a semantic field of the error, not presentation: dropping
  // it turns a transient admission failure into a permanent one and changes
  // the remediation the caller is shown.
  const error = new AnalysisCapabilityUnavailableError(
    "mitmproxy",
    "inspect_web_network_capture",
    "Runtime admission for /targets/private/capture failed transiently",
    { retryable: true },
  );
  expect(projectAnalysisError(error).retryable).toBe(true);
  const result = redactExplicitFailure(error, ["private"]);
  expect(result).toBeInstanceOf(AnalysisCapabilityUnavailableError);
  expect((result as AnalysisCapabilityUnavailableError).retryable).toBe(true);
  expect(projectAnalysisError(result).retryable).toBe(true);
  expect(JSON.stringify(projectAnalysisError(result))).not.toContain("private");
});

it("coarsens format issue pointers without creating replacement coordinates", () => {
  const error = new AnalysisInputError(
    "inspect_web_network_capture",
    undefined,
    [
      {
        path: ["capture_path", "/metadata/private~1~0/nested"],
        reason: "invalid_format",
        message: "Malformed private field",
      },
    ],
  );
  const result = redactExplicitFailure(error, ["private/~", "private"]);
  if (!(result instanceof AnalysisInputError))
    throw new Error("Input error required");
  expect(result.issues[0]?.path).toEqual(["capture_path", "/metadata"]);
});

it("excludes a marked permission-denied path without losing its host error code", () => {
  const error = redactExplicitFailure(
    new AnalysisAccessDeniedError(
      "inspect_web_network_capture",
      "/declared-path-value/capture.har",
      "EACCES",
    ),
    ["declared-path-value"],
  );
  expect(error._tag).toBe("AnalysisAccessDeniedError");
  const projected = projectAnalysisError(error);
  expect(projected).toMatchObject({
    code: "access_denied",
    category: "unavailable",
    details: { system_code: "EACCES" },
  });
  expect(JSON.stringify(projected)).not.toContain("declared-path-value");
});

it("coarsens ordinary sensitive issue-path segments to their real parent", () => {
  const input = new AnalysisInputError(
    "inspect_web_network_capture",
    undefined,
    [
      {
        path: ["input", "mysecret", "child"],
        reason: "unknown_argument",
        message: "Unrecognized mysecret",
      },
    ],
  );
  const result = redactExplicitFailure(input, ["secret"]);
  if (!(result instanceof AnalysisInputError))
    throw new Error("Input error required");
  expect(result.issues[0]?.path).toEqual(["input"]);
  expect(JSON.stringify(projectAnalysisError(result))).not.toContain("secret");
});

it("does not reinterpret an unknown argument name as a JSON pointer", () => {
  const input = new AnalysisInputError(
    "inspect_web_network_capture",
    undefined,
    [{ path: ["/ordinary/secret"], reason: "unknown_argument" }],
  );
  const result = redactExplicitFailure(input, ["secret"]);
  if (!(result instanceof AnalysisInputError))
    throw new Error("Input error required");
  expect(result.issues[0]?.path).toEqual([]);
});
