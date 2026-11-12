import { Cli } from "incur";
import { expect, it } from "vitest";
import { registerAdbCommands } from "../../../src/cli/adbCommands.js";
import { createLogger } from "../../../src/logger.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { AnalysisTimeoutError } from "../../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err } from "../../../src/domain/result.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";

it.each(["typed", "unexpected"])(
  "preserves recovered action facts and both failures when CLI close fails (%s)",
  async (kind) => {
    const operation = "stop_adb_app";
    const partial = createEvidence(
      undefined,
      { id: "adb", name: "ADB fixture", version: "1" },
      {
        operation: "perform_adb_ui_action",
        parameters: { serial: "emulator-5554" },
        result: {
          dispatch_attempted: true,
          action_completed: true,
          after: null,
          observation_failure: "device offline after action",
        },
        authority: "controlled-replay",
        subjectUnavailableReason: "Scripted CLI lifecycle boundary",
      },
    );
    const primary = new AnalysisTimeoutError(operation, 100, {
      partialObservation: partial,
    });
    const cleanup =
      kind === "typed"
        ? new ProviderCleanupError(
            "adb",
            ["runner-request:test"],
            { reason: "device still offline" },
            { operation },
          )
        : new Error("device still offline");
    let closes = 0;
    const cli = Cli.create("rea-adb-cleanup-test", { sync: false });
    registerAdbCommands(
      cli,
      createLogger("cli", "silent"),
      {},
      {
        async inspectAvailability() {
          return {
            status: "available",
            code: null,
            reason: null,
            diagnostics: {},
          };
        },
        async execute() {
          return err(primary);
        },
        async close() {
          closes++;
          throw cleanup;
        },
      },
    );
    let stdout = "";
    await cli.serve(
      ["stop-adb-app", "emulator-5554", "com.example.app", "--json"],
      {
        env: {},
        exit() {},
        stdout(text) {
          stdout += text;
        },
      },
    );
    const result = JSON.parse(stdout);
    expect(closes).toBe(1);
    expect(result).toMatchObject({
      code: "cleanup_incomplete",
      message: projectAnalysisError(primary).message,
    });
    expect(JSON.stringify(result)).toContain(partial.evidence_id);
    expect(JSON.stringify(result)).toContain('"action_completed":true');
    expect(result.details.diagnostics).toMatchObject({
      primary_error: { details: { operation } },
      cleanup_error: { code: "cleanup_incomplete" },
    });
  },
);
