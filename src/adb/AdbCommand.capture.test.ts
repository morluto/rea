import { expect, it } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { runAdbCapture } from "./AdbCommand.js";

// Exercise the real subprocess capture and public error projection, substituting
// only the bring-your-own executable. These are not Android-device checks.
it.each([
  {
    name: "overflow",
    source: 'process.stdout.write("X".repeat(4096))',
    maxOutputBytes: 64,
    code: "resource_constraint",
    stdout: "X".repeat(64),
    stderr: "",
    truncated: true,
  },
  {
    name: "timeout",
    source:
      'process.stdout.write("partial-雪"); process.stderr.write("waiting\\n"); setInterval(() => {}, 1000)',
    code: "provider_timeout",
    timeoutMs: 500,
    stdout: "partial-雪",
    stderr: "waiting\n",
  },
  {
    name: "offline device",
    source:
      'process.stdout.write("partial-雪"); process.stderr.write("adb: error: device offline\\n"); process.exitCode = 1',
    code: "unsupported_target",
    expectedPath: "caller-device",
    stdout: "partial-雪",
    stderr: "adb: error: device offline\n",
  },
  {
    name: "local path refusal",
    source:
      'process.stdout.write("partial-雪"); process.stderr.write("adb: error: cannot stat \'/host/token file\': Permission denied\\n"); process.exitCode = 1',
    code: "unsupported_target",
    expectedPath: "/host/token file",
    stdout: "partial-雪",
    stderr: "adb: error: cannot stat '/host/token file': Permission denied\n",
  },
])("preserves bounded capture on $name", async (testCase) => {
  const result = await runAdbCapture(
    "pull_adb_file",
    {
      device: "caller-device",
      path: "/remote/source",
      localPath: "/host/token file",
    },
    {
      binary: process.execPath,
      pathSource: "environment",
      environment: { REA_TEST_PRIVATE: "ambient-value-must-not-be-persisted" },
    },
    ["-e", testCase.source],
    {
      timeoutMs: testCase.timeoutMs ?? 5_000,
      maxOutputBytes: testCase.maxOutputBytes ?? 1024,
    },
    undefined,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  const projected = projectAnalysisError(result.error);
  expect(projected).toMatchObject({
    code: testCase.code,
    details: {
      captured_output: {
        stdout: testCase.stdout,
        stderr: testCase.stderr,
        stdout_bytes: Buffer.byteLength(testCase.stdout),
        stderr_bytes: Buffer.byteLength(testCase.stderr),
        truncated: testCase.truncated ?? false,
      },
    },
  });
  if (testCase.code === "unsupported_target")
    expect(projected.details?.path).toBe(testCase.expectedPath);
  if (testCase.code === "provider_timeout") {
    expect(projected.details?.timeout_ms).toBe(testCase.timeoutMs);
    expect(projected.details?.limit).toBeUndefined();
  }
  expect(JSON.stringify(projected)).not.toContain(
    "ambient-value-must-not-be-persisted",
  );
});

it.each([true, false])(
  "projects a truncated adb capture as retryable only for volatile output (%s)",
  async (volatileOutput) => {
    const result = await runAdbCapture(
      volatileOutput ? "read_adb_logcat" : "install_adb_package",
      { device: "device" },
      { binary: process.execPath, pathSource: "environment", environment: {} },
      ["-e", 'process.stdout.write("X".repeat(4096))'],
      { timeoutMs: 5_000, maxOutputBytes: 1024, volatileOutput },
      undefined,
    );
    if (result.ok) throw new Error("Expected a capture allowance refusal");
    const projected = projectAnalysisError(result.error);
    expect(projected.retryable).toBe(volatileOutput);
    expect(projected).toMatchObject({
      code: "resource_constraint",
      details: { reported_limits: { max_output_bytes: 1024 } },
    });
    expect(projected.details?.limit).toBeUndefined();
  },
);
