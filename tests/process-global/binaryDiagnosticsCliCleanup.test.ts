import { afterEach, expect, it, vi } from "vitest";

import { createCli } from "../../src/cli.js";
import { cliCommandFor } from "../../src/contracts/cliCommandNames.js";
import * as binaryLayoutComposition from "../../src/composition/binaryDiagnostics/binaryLayout.js";
import * as recordedCrashComposition from "../../src/composition/binaryDiagnostics/recordedCrash.js";
import { BinaryLayoutService } from "../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { RecordedCrashService } from "../../src/application/binaryDiagnostics/RecordedCrashService.js";
import { AnalysisOutputError } from "../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../src/domain/providerCleanupError.js";
import { err } from "../../src/domain/result.js";
import { analysisErrorWithCleanupFailure } from "../../src/domain/analysisErrorCleanup.js";
import { releaseOwnedCleanup } from "../support/cleanupRelease.js";

const exitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = exitCode;
});

it.each(
  (["layout", "recorded"] as const).flatMap((scenario) => [
    { scenario, recovered: false },
    { scenario, recovered: true },
  ]),
)(
  "projects the final owned outcome through the public CLI: $scenario recovered=$recovered",
  async ({ scenario, recovered }) => {
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
    const composed = analysisErrorWithCleanupFailure(
      primary,
      cleanup,
      "inspect_binary_layout",
    ).bindCleanupDependencies([primary, cleanup]);
    if (recovered) releaseOwnedCleanup(cleanup);
    const inspectAndClose = vi.fn(async () => err(composed));
    const identity = {
      id: "fixture-decoder",
      name: "Fixture decoder",
      version: "1",
    };
    if (scenario === "layout")
      vi.spyOn(
        binaryLayoutComposition,
        "createBinaryLayoutService",
      ).mockReturnValue(
        new BinaryLayoutService({
          identity,
          inspect: () => {
            throw new Error("CLI must request a terminal inspection");
          },
          inspectAndClose,
        }),
      );
    else
      vi.spyOn(
        recordedCrashComposition,
        "createRecordedCrashService",
      ).mockReturnValue(
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
          ? cliCommandFor("inspect_binary_layout")
          : cliCommandFor("inspect_recorded_crash"),
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
      code: recovered ? "unreadable_output" : "cleanup_incomplete",
      details: {
        ...(recovered
          ? {}
          : {
              cleanup: "incomplete",
              resources: ["owned-process", "/retained/runtime"],
            }),
        captured_output: {
          stdout: "partial original output",
          stderr: "warning",
          truncated: true,
        },
        [recovered ? "cleanup_history" : "diagnostics"]: {
          primary_error: { code: "unreadable_output" },
          cleanup_error: { code: "cleanup_incomplete" },
        },
      },
    });
    if (recovered) {
      expect(output).not.toHaveProperty("details.cleanup");
      expect(output).not.toHaveProperty("details.resources");
    }
    expect(inspectAndClose).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  },
);
