import { expect, it, vi } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import {
  AdbConfigurationFailure,
  adbConfigurationAvailability,
  inspectAdbClient,
} from "./AdbConfiguration.js";

vi.mock("../process/ExecFileOutput.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/ExecFileOutput.js")>()),
  execFileOutput: vi.fn(),
}));

const selection = {
  binary: "/host/adb",
  pathSource: "environment",
  environment: {},
} as const;

it("reports the fixed adb version-probe deadline", async () => {
  vi.mocked(execFileOutput).mockRejectedValueOnce(
    Object.assign(new Error("deadline"), {
      code: "ETIMEDOUT",
      stdout: "",
      stderr: "",
      signal: null,
      killed: true,
    }),
  );
  const failure = await inspectAdbClient(selection).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toBeInstanceOf(AnalysisTimeoutError);
  const projected = projectAnalysisError(failure as AnalysisTimeoutError);
  expect(projected).toMatchObject({
    code: "provider_timeout",
    details: { timeout_ms: 10_000 },
  });
  expect(projected.details?.limit).toBeUndefined();
});

it("reports the fixed adb version-output cap", async () => {
  vi.mocked(execFileOutput).mockRejectedValueOnce(
    Object.assign(new Error("too much"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
      outputTruncated: true,
    }),
  );
  const failure = await inspectAdbClient(selection).catch(
    (cause: unknown) => cause,
  );
  const projected = projectAnalysisError(
    failure as Parameters<typeof projectAnalysisError>[0],
  );
  expect(projected).toMatchObject({
    code: "resource_constraint",
    retryable: false,
    details: {
      resource: "memory",
      reported_limits: { max_output_bytes: 65536 },
    },
  });
  expect(projected.details?.limit).toBeUndefined();
});

it("distinguishes execute denial from missing or unreadable version output", async () => {
  vi.mocked(execFileOutput).mockRejectedValueOnce(
    Object.assign(new Error("denied"), {
      code: "EACCES",
      spawnFailed: true,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
    }),
  );
  await expect(inspectAdbClient(selection)).rejects.toMatchObject({
    code: "binary_not_executable",
    diagnostics: {
      selected_binary: selection.binary,
      filesystem_error: "EACCES",
    },
  });
});

it("names an EPERM execute refusal separately from missing permission", async () => {
  vi.mocked(execFileOutput).mockRejectedValueOnce(
    Object.assign(new Error("not permitted"), {
      code: "EPERM",
      spawnFailed: true,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
    }),
  );
  await expect(inspectAdbClient(selection)).rejects.toMatchObject({
    code: "binary_not_executable",
    diagnostics: {
      selected_binary: "/host/adb",
      path_source: "environment",
      filesystem_error: "EPERM",
      remediation: expect.stringContaining("REA_ADB_PATH") as unknown,
    },
  });
});

it("names any other not-started spawn errno without an exit code", async () => {
  vi.mocked(execFileOutput).mockRejectedValueOnce(
    Object.assign(new Error("spawn EINVAL"), {
      code: "EINVAL",
      spawnFailed: true,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
    }),
  );
  const failure = await inspectAdbClient(selection).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toMatchObject({
    code: "binary_not_executable",
    diagnostics: {
      selected_binary: "/host/adb",
      path_source: "environment",
      filesystem_error: "EINVAL",
      remediation: expect.stringContaining("REA_ADB_PATH") as unknown,
    },
  });
  expect(failure).not.toHaveProperty("diagnostics.exit_code");
});

it("does not blame the selected path for exhausted host spawn capacity", async () => {
  vi.mocked(execFileOutput).mockRejectedValueOnce(
    Object.assign(new Error("spawn EMFILE"), {
      code: "EMFILE",
      spawnFailed: true,
      stdout: "",
      stderr: "",
      signal: null,
      killed: false,
    }),
  );
  const failure = await inspectAdbClient(selection).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toMatchObject({
    code: "host_capacity",
    diagnostics: {
      selected_binary: "/host/adb",
      path_source: "environment",
      filesystem_error: "EMFILE",
      remediation: expect.any(String) as unknown,
    },
  });
  expect(failure).not.toHaveProperty("diagnostics.exit_code");
  if (!(failure instanceof AdbConfigurationFailure)) throw failure;
  expect(adbConfigurationAvailability(failure)).toMatchObject({
    status: "unavailable",
    code: "runtime_unavailable",
  });
});
