import { afterEach, expect, it, vi } from "vitest";

import { createCli } from "../../src/cli.js";
import { CLI_COMMANDS } from "../../src/cliCommandNames.js";
import * as composition from "../../src/composition/binaryDiagnostics.js";
import { BinaryLayoutService } from "../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { RecordedCrashService } from "../../src/application/binaryDiagnostics/RecordedCrashService.js";
import { AnalysisOutputError } from "../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { err } from "../../src/domain/result.js";
import { analysisErrorWithCleanupFailure } from "../../src/domain/analysisErrorCleanup.js";

const exitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCode;
});

it.each(["layout", "recorded"] as const)(
  "projects the final owned outcome through the public CLI: %s",
  async (scenario) => {
    const primary = new AnalysisOutputError(
      "inspect_binary_layout",
      "fixture decoder output overflow",
      {
        capturedOutput: {
          stdout: "partial original output",
          stderr: "warning",
          truncated: true,
        },
      },
    );
    const cleanup = new ProviderCleanupError(
      "fixture-decoder",
      ["owned-process", "/retained/runtime"],
      { reason: "fixture process inspection still denied" },
    );
    const inspectAndClose = vi.fn(async () =>
      err(
        analysisErrorWithCleanupFailure(
          primary,
          cleanup,
          "inspect_binary_layout",
        ),
      ),
    );
    const identity = {
      id: "fixture-decoder",
      name: "Fixture decoder",
      version: "1",
    };
    if (scenario === "layout")
      vi.spyOn(composition, "createBinaryLayoutService").mockReturnValue(
        new BinaryLayoutService({
          identity,
          inspect: () => {
            throw new Error("CLI must request a terminal inspection");
          },
          inspectAndClose,
        }),
      );
    else
      vi.spyOn(composition, "createRecordedCrashService").mockReturnValue(
        new RecordedCrashService({
          identity,
          inspect: () => {
            throw new Error("CLI must request a terminal inspection");
          },
          inspectAndClose,
        }),
      );

    const cli = createCli({});
    let stdout = "";
    await cli.serve(
      [
        scenario === "layout"
          ? CLI_COMMANDS.inspectBinaryLayout
          : CLI_COMMANDS.inspectRecordedCrash,
        "/selected/fixture.elf",
        "--json",
      ],
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
      code: "cleanup_incomplete",
      details: {
        cleanup: "incomplete",
        resources: ["owned-process", "/retained/runtime"],
        captured_output: {
          stdout: "partial original output",
          stderr: "warning",
          truncated: true,
        },
        diagnostics: {
          primary_error: { code: "unreadable_output" },
          cleanup_error: { code: "cleanup_incomplete" },
        },
      },
    });
    expect(inspectAndClose).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  },
);
