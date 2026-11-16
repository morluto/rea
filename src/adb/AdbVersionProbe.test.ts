import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";

import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  AnalysisResourceConstraintError,
  AnalysisTimeoutError,
} from "../domain/analysisErrorCore.js";
import { execFileOutput } from "../process/ExecFileOutput.js";
import { spawnFailure } from "../../tests/support/process/spawnFailure.js";
import { inspectAdbClient } from "./AdbConfiguration.js";

vi.mock("../process/ExecFileOutput.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../process/ExecFileOutput.js")>();
  return { ...actual, execFileOutput: vi.fn(actual.execFileOutput) };
});

const selection = {
  binary: "/host/adb",
  pathSource: "environment",
  environment: {},
} as const;

/** The error execFile rejects with when its launcher could not start adb. */
const adbSpawnFailure = (code: string): Error =>
  Object.assign(spawnFailure(code, selection.binary), {
    spawnFailed: true,
    stdout: "",
    stderr: "",
    signal: null,
    killed: false,
  });

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
  let selected: string = selection.binary;
  if (process.platform === "win32") {
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
  } else {
    const root = await mkdtemp(join(tmpdir(), "rea-adb-version-cap-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    selected = join(root, "adb");
    await writeFile(
      selected,
      `#!${process.execPath}\nprocess.stdout.write("x".repeat(100_000));\n`,
      { mode: 0o755 },
    );
  }
  const failure = await inspectAdbClient({
    ...selection,
    binary: selected,
  }).catch((cause: unknown) => cause);
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
  expect(failure).toHaveProperty("fixedAllowance", {
    name: expect.any(String),
    kind: "capture",
    limit: 65536,
    unit: "bytes",
  });
});

it.skipIf(process.platform !== "win32")(
  "classifies an EACCES execute refusal on Windows",
  async () => {
    vi.mocked(execFileOutput).mockRejectedValueOnce(adbSpawnFailure("EACCES"));
    await expect(inspectAdbClient(selection)).rejects.toMatchObject({
      code: "binary_not_executable",
      diagnostics: {
        selected_binary: selection.binary,
        filesystem_error: "EACCES",
      },
    });
  },
);

it("names an EPERM execute refusal separately from missing permission", async () => {
  vi.mocked(execFileOutput).mockRejectedValueOnce(adbSpawnFailure("EPERM"));
  await expect(inspectAdbClient(selection)).rejects.toMatchObject({
    code: "binary_not_executable",
    remediation: expect.stringContaining("REA_ADB_PATH") as unknown,
    diagnostics: {
      selected_binary: "/host/adb",
      path_source: "environment",
      filesystem_error: "EPERM",
    },
  });
});

it("names any other not-started spawn errno without an exit code", async () => {
  vi.mocked(execFileOutput).mockRejectedValueOnce(adbSpawnFailure("EINVAL"));
  const failure = await inspectAdbClient(selection).catch(
    (cause: unknown) => cause,
  );
  expect(failure).toMatchObject({
    code: "binary_not_executable",
    remediation: expect.stringContaining("REA_ADB_PATH") as unknown,
    diagnostics: {
      selected_binary: "/host/adb",
      path_source: "environment",
      filesystem_error: "EINVAL",
    },
  });
  expect(failure).not.toHaveProperty("diagnostics.exit_code");
});

it.each([
  ["EMFILE", true, { boundary: "host-capacity" }],
  // `adb version` has fixed arguments, so only the environment can shrink.
  [
    "E2BIG",
    false,
    { boundary: "provider-launch", oversized_launch_input: "environment" },
  ],
] as const)(
  "reports a host launch constraint %s through the shared launch owner, not as a fault of the selected path",
  async (code, retryable, facts) => {
    vi.mocked(execFileOutput).mockRejectedValueOnce(adbSpawnFailure(code));
    const failure = await inspectAdbClient(selection).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toBeInstanceOf(AnalysisResourceConstraintError);
    const projected = projectAnalysisError(
      failure as AnalysisResourceConstraintError,
    );
    expect(projected).toMatchObject({
      code: "resource_constraint",
      retryable,
      details: {
        diagnostics: {
          selected_binary: "/host/adb",
          path_source: "environment",
          system_code: code,
          command: "/host/adb",
          ...facts,
        },
      },
    });
    expect(projected).not.toHaveProperty("details.diagnostics.exit_code");
  },
);
it.skipIf(process.platform === "win32").each([
  {
    name: "an actual executable path with trailing space",
    fileName: "adb ",
    installedLine: (binary: string) => `Installed as ${binary}\n`,
    expectedPath: (binary: string) => binary,
  },
  {
    name: "a CRLF installed-path record",
    fileName: "adb",
    installedLine: (binary: string) => `Installed as ${binary}\r\n`,
    expectedPath: (binary: string) => binary,
  },
  {
    name: "an omitted installed-path record",
    fileName: "adb",
    installedLine: () => "",
    expectedPath: () => null,
  },
  {
    name: "an empty installed-path record before another field",
    fileName: "adb",
    installedLine: () => "Installed as \n",
    expectedPath: () => null,
  },
])("preserves the source identity for $name", async (testCase) => {
  const root = await mkdtemp(join(tmpdir(), "rea-adb-version-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, testCase.fileName);
  const output =
    "Android Debug Bridge version 1.0.41\nVersion 35.0.2-stub\n" +
    testCase.installedLine(binary) +
    "Running on Linux\n";
  await writeFile(
    binary,
    `#!${process.execPath}\nif (process.argv[2] !== "version") throw Error("No device command allowed");\nprocess.stdout.write(${JSON.stringify(output)});\n`,
    { mode: 0o755 },
  );
  expect(
    await inspectAdbClient({
      binary,
      pathSource: "environment",
      environment: {},
    }),
  ).toEqual({
    version: "35.0.2-stub",
    installedPath: testCase.expectedPath(binary),
  });
});
