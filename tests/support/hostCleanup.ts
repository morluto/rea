import { expect } from "vitest";

import type { ProcessCaptureError } from "../../src/process/capture/ProcessCaptureError.js";

type SerializedCleanupFailure = {
  readonly error: {
    readonly code: unknown;
    readonly details: {
      readonly cleanup_report: {
        readonly owned_process_group: {
          readonly state: unknown;
          readonly reason: unknown;
        };
        readonly terminal_renderer: { readonly state: unknown };
        readonly temporary_root: { readonly state: unknown };
      };
      readonly partial_observation: unknown;
    };
  };
};

const expectHostCleanupReport = (report: {
  readonly owned_process_group: {
    readonly state: unknown;
    readonly reason: unknown;
  };
  readonly terminal_renderer: { readonly state: unknown };
  readonly temporary_root: { readonly state: unknown };
}): void => {
  expect(report.owned_process_group.state).toBe("unverified");
  const reason = report.owned_process_group.reason;
  expect(typeof reason).toBe("string");
  if (typeof reason !== "string")
    throw new Error("cleanup report omitted reason");
  const category =
    process.platform === "linux"
      ? "environment_errno_(?:EACCES|EPERM)"
      : "environment_unavailable";
  const candidate =
    "[1-9][0-9]*=(?:environment_unavailable|environment_errno_(?:EACCES|EPERM))";
  expect(reason).toMatch(
    new RegExp(
      `^process ownership token could not be read for [1-9][0-9]* live process\\(es\\): ` +
        `${category}=[1-9][0-9]*(?:, ${category}=[1-9][0-9]*)*; ` +
        `live candidates ${candidate}(?:, ${candidate})*$`,
      "u",
    ),
  );
  expect(report.terminal_renderer.state).toBe("cleaned");
  expect(report.temporary_root.state).toBe("cleaned");
};

/** Permit only the host ownership-token cleanup flake seen by real captures. */
export const expectUnverifiedHostCleanup = (
  error: ProcessCaptureError,
): void => {
  expect(error.reason, error.message).toBe("cleanup_incomplete");
  const report = error.cleanupReport;
  expect(report).toBeDefined();
  if (report === undefined)
    throw new Error("cleanup-incomplete error omitted report");
  expectHostCleanupReport(report);
};

/**
 * Assert the same narrowly-defined cleanup flake after CLI/MCP serialization
 * and return the observations that callers must continue to verify.
 */
export const expectSerializedUnverifiedHostCleanup = (
  value: unknown,
): unknown => {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  if (typeof value !== "object" || value === null || !("error" in value))
    throw new Error("cleanup error omitted its serialized error envelope");
  const error = value.error;
  expect(typeof error).toBe("object");
  expect(error).not.toBeNull();
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    !("details" in error)
  )
    throw new Error("cleanup error omitted its serialized details");
  expect(error.code).toBe("cleanup_incomplete");
  const details = error.details;
  expect(typeof details).toBe("object");
  expect(details).not.toBeNull();
  if (
    typeof details !== "object" ||
    details === null ||
    !("cleanup_report" in details) ||
    !("partial_observation" in details)
  )
    throw new Error("cleanup error omitted report or partial observation");
  const cleanupReport = details.cleanup_report;
  expect(typeof cleanupReport).toBe("object");
  expect(cleanupReport).not.toBeNull();
  if (
    typeof cleanupReport !== "object" ||
    cleanupReport === null ||
    !("owned_process_group" in cleanupReport) ||
    !("terminal_renderer" in cleanupReport) ||
    !("temporary_root" in cleanupReport)
  )
    throw new Error("cleanup error report is incomplete");
  expectHostCleanupReport(
    cleanupReport as SerializedCleanupFailure["error"]["details"]["cleanup_report"],
  );
  return details.partial_observation;
};
