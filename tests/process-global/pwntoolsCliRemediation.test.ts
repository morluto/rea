import { SIMULATED_LINUX_X64 } from "../fixtures/simulatedHost.js";
import { writeFile } from "node:fs/promises";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";

import { createCli } from "../../src/cli.js";
import * as binaryLayoutComposition from "../../src/composition/binaryDiagnostics/binaryLayout.js";
import * as recordedCrashComposition from "../../src/composition/binaryDiagnostics/recordedCrash.js";
import { BinaryLayoutService } from "../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { RecordedCrashService } from "../../src/application/binaryDiagnostics/RecordedCrashService.js";
import { PwntoolsLayoutProvider } from "../../src/native/pwntools/PwntoolsLayoutProvider.js";
import { PwntoolsRecordedCrashProvider } from "../../src/native/pwntools/PwntoolsRecordedCrashProvider.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../support/workspace/workspaceFixture.js";

const exitCode = process.exitCode;

afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
});

it
  .skipIf(process.platform === "win32")
  .each(["inspect-binary-layout", "inspect-recorded-crash"] as const)(
  "reports actionable configuration failures through %s",
  async (command) => {
    const workspace = await createTestWorkspace("rea-pwntools-remediation-");
    onTestFinished(() => removeTestWorkspace(workspace.root));
    const nonExecutable = workspace.path("python-no-execute");
    await writeFile(nonExecutable, "not executable", { mode: 0o600 });
    const missing = workspace.path("missing-python");
    const configurations = [
      {
        environment: {},
        message: "Set REA_PWNTOOLS_PYTHON",
        key: "REA_PWNTOOLS_PYTHON",
      },
      {
        environment: { REA_PWNTOOLS_PYTHON: workspace.root },
        message: "not a directory",
        key: "REA_PWNTOOLS_PYTHON",
      },
      {
        environment: { REA_PWNTOOLS_PYTHON: missing },
        message: "ENOENT",
        key: "REA_PWNTOOLS_PYTHON",
      },
      {
        environment: { REA_PWNTOOLS_PYTHON: nonExecutable },
        message: "EACCES",
        key: "REA_PWNTOOLS_PYTHON",
      },
      {
        environment: {
          REA_PWNTOOLS_PYTHON: process.execPath,
          REA_PWNTOOLS_MAX_INPUT_BYTES: "0",
        },
        message: "REA_PWNTOOLS_MAX_INPUT_BYTES",
        key: "REA_PWNTOOLS_MAX_INPUT_BYTES",
      },
    ];
    for (const { environment, message, key } of configurations) {
      if (command === "inspect-binary-layout")
        vi.spyOn(
          binaryLayoutComposition,
          "createBinaryLayoutService",
        ).mockReturnValue(
          new BinaryLayoutService(
            new PwntoolsLayoutProvider(
              environment,
              undefined,
              undefined,
              SIMULATED_LINUX_X64,
            ),
          ),
        );
      else
        vi.spyOn(
          recordedCrashComposition,
          "createRecordedCrashService",
        ).mockReturnValue(
          new RecordedCrashService(
            new PwntoolsRecordedCrashProvider(
              environment,
              undefined,
              undefined,
              SIMULATED_LINUX_X64,
            ),
          ),
        );
      let stdout = "";
      process.exitCode = 0;
      await createCli({}).serve(
        [command, workspace.path("selected.elf"), "--json"],
        {
          env: {},
          stdout: (text) => {
            stdout += text;
          },
          exit: () => undefined,
        },
      );
      const output: unknown = JSON.parse(stdout);
      expect(output).toMatchObject({
        code: "provider_unavailable",
        message: expect.stringContaining(message),
        remediation: { action: expect.stringContaining(message) },
        details: {
          requested_provider_id: "pwntools-elf",
          rejections: [
            {
              reason: expect.stringContaining(message),
              diagnostics: { configuration_key: key },
            },
          ],
        },
      });
      expect(stdout).not.toContain("rea doctor");
      expect(process.exitCode).toBe(1);
    }
  },
);
