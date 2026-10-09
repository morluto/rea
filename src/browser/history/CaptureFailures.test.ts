import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { analysisErrorProjectionSchema } from "../../contracts/errorSchemas.js";
import { inspectWebNetworkCaptureInputSchema } from "../../domain/webNetworkCapture.js";
import { historicalCaptureFailure } from "./CaptureFailures.js";
import { redactExplicitFailure } from "../../domain/explicitSensitiveFailure.js";
import { OwnedCommandFailure } from "../../process/OwnedCommand.js";

it.each([
  { label: "POSIX SIGABRT", exitCode: null, signal: "SIGABRT" },
  { label: "Windows exit 134", exitCode: 134, signal: null },
] as const)(
  "reports HAR heap exhaustion for $label",
  ({ exitCode, signal }) => {
    const input = inspectWebNetworkCaptureInputSchema.parse({
      capture_path: "/selected/input.har",
      format: "har",
    });
    const stderr =
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\r\n";
    const cause = new OwnedCommandFailure("process", "Decoder failed", {
      stdout: { text: "", bytes: 0 },
      stderr: { text: stderr, bytes: Buffer.byteLength(stderr) },
      exitCode,
      signal,
    });
    const projected = analysisErrorProjectionSchema.parse(
      projectAnalysisError(historicalCaptureFailure(input, cause, "decoder")),
    );
    expect(projected).toMatchObject({
      code: "resource_constraint",
      retryable: false,
      message: expect.stringContaining("fixed V8 heap"),
      remediation: {
        action: expect.stringContaining(
          "smaller capture exported by its producer",
        ),
      },
      details: {
        resource: "memory",
        reported_limits: {
          observed_exit_code: exitCode,
          observed_signal: signal,
        },
        captured_output: { stdout: "", stderr },
      },
    });
    expect(JSON.stringify(projected)).not.toContain("rea doctor");
  },
);

it.each([
  { exitCode: 134, signal: null, stderr: "Fatal decoder crash" },
  {
    exitCode: 2,
    signal: null,
    stderr: "FATAL ERROR: JavaScript heap out of memory",
  },
  {
    exitCode: null,
    signal: "SIGTERM",
    stderr: "FATAL ERROR: JavaScript heap out of memory",
  },
] as const)(
  "preserves unrelated decoder failures %#",
  ({ exitCode, signal, stderr }) => {
    const input = inspectWebNetworkCaptureInputSchema.parse({
      capture_path: "/selected/input.har",
      format: "har",
    });
    const cause = new OwnedCommandFailure("process", "Decoder failed", {
      stdout: { text: "", bytes: 0 },
      stderr: { text: stderr, bytes: Buffer.byteLength(stderr) },
      exitCode,
      signal,
    });
    expect(
      projectAnalysisError(historicalCaptureFailure(input, cause, "decoder")),
    ).toMatchObject({
      code: "execution_failure",
      details: { diagnostics: { exit_code: exitCode, signal, stderr } },
    });
  },
);

it.each(["before open", "during read"])(
  "preserves observed capture changes %s as retryable acquisition integrity failures",
  (stage) => {
    const path = "/selected/private-marker.har";
    const input = inspectWebNetworkCaptureInputSchema.parse({
      capture_path: path,
      format: "har",
    });
    const cause = new ArtifactReaderFailure(
      "integrity",
      `Artifact changed ${stage}: ${path}`,
    );
    const error = historicalCaptureFailure(input, cause, "capture-read");
    const projected = projectAnalysisError(error);
    expect(analysisErrorProjectionSchema.parse(projected)).toMatchObject({
      code: "artifact_changed",
      category: "integrity_mismatch",
      retryable: true,
      details: {
        operation: "inspect_web_network_capture",
        path,
        boundary: "stable-artifact-read",
        reason: cause.message,
      },
    });
    expect(projected.remediation.action).toContain("stable");
    const redacted = projectAnalysisError(
      redactExplicitFailure(error, ["private-marker", "REDACTED"]),
    );
    expect(redacted.code).toBe("artifact_changed");
    expect(JSON.stringify(redacted)).not.toContain("private-marker");
    expect(JSON.stringify(redacted)).not.toContain("REDACTED");
  },
);

it("retains actual command status and both diagnostic streams when cleanup also fails", () => {
  const input = inspectWebNetworkCaptureInputSchema.parse({
    capture_path: "/selected/input.har",
    format: "har",
  });
  const cause = new OwnedCommandFailure(
    "process",
    "Observed command failure",
    {
      stdout: { text: "original provider output", bytes: 24 },
      stderr: { text: "private-marker provider reason", bytes: 30 },
      exitCode: 2,
      signal: null,
    },
    "Observed cleanup failure",
    undefined,
    ["pid:42"],
  );
  const error = historicalCaptureFailure(input, cause, "decoder");
  expect(projectAnalysisError(error)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      diagnostics: {
        previous_error: {
          failure_kind: "process",
          exit_code: 2,
          stdout: "original provider output",
          stderr: "private-marker provider reason",
        },
      },
    },
  });
  const redacted = projectAnalysisError(
    redactExplicitFailure(error, ["private-marker"]),
  );
  expect(JSON.stringify(redacted)).not.toContain("private-marker");
  expect(redacted.code).toBe("cleanup_incomplete");
});
it.each(["io", "unavailable"] as const)(
  "keeps %s read failures separate from malformed capture input",
  (reason) => {
    const input = inspectWebNetworkCaptureInputSchema.parse({
      capture_path: "/selected/input.har",
      format: "har",
    });
    const error = historicalCaptureFailure(
      input,
      new ArtifactReaderFailure(reason, "Observed acquisition failure"),
      "capture-read",
    );
    expect(projectAnalysisError(error)).toMatchObject({
      code: "execution_failure",
      category: "execution_failure",
      details: { diagnostics: { phase: "capture-read", failure_kind: reason } },
    });
  },
);
