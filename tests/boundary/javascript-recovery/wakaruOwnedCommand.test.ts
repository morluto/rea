import { createTestArtifactResourceScope } from "../../fixtures/artifactResourceScope.js";
import { expect, it } from "vitest";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { primaryAnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { runWakaruCommand } from "../../../src/javascript/recovery/WakaruCommand.js";
import { RECOVERY_LIMITS } from "../../../src/javascript/recovery/WakaruRelease.js";
import {
  spawnOwnedProviderProcess,
  type SpawnedOwnedProviderProcess,
} from "../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";

// Only this authored Node diagnostic producer runs: no Wakaru, prlimit, or
// selected/recovered application source is executed by this fixture.
it.skipIf(process.platform === "win32").each([
  {
    bytes: RECOVERY_LIMITS.reportBytes - 1,
    overflow: false,
    lateCancel: false,
  },
  { bytes: RECOVERY_LIMITS.reportBytes, overflow: false, lateCancel: false },
  { bytes: RECOVERY_LIMITS.reportBytes + 1, overflow: true, lateCancel: true },
  { bytes: 17, overflow: false, lateCancel: true },
])(
  "preserves per-stream allowance and physical nonzero exit for $bytes diagnostic bytes (late cancellation: $lateCancel)",
  async ({ bytes, overflow, lateCancel }) => {
    const controller = new AbortController();
    const reason = { caller: "late abort after owned fixture cleanup" };
    let spawned: SpawnedOwnedProviderProcess | undefined;
    try {
      const result = await runWakaruCommand({
        resources: createTestArtifactResourceScope(),
        command: "/unused/wakaru",
        limiter: "/unused/prlimit",
        arguments: [],
        cwd: process.cwd(),
        environment: {},
        deadline: performance.now() + 10_000,
        signal: controller.signal,
        launcher: async (options) => {
          spawned = await spawnOwnedProviderProcess({
            ...options,
            command: process.execPath,
            arguments: [
              "-e",
              `process.stderr.write(Buffer.alloc(${bytes}, 97), () => { process.stdout.write('owned fixture stdout'); process.exitCode = 17; });`,
            ],
          });
          const owned = spawned;
          return {
            ...owned,
            cleanup: async () => {
              const cleanup = await cleanupOwnedProcessGroup(owned.ownership);
              if (lateCancel) controller.abort(reason);
              return cleanup;
            },
          };
        },
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (!overflow && !lateCancel) {
        if (!result.ok) throw result.error;
        expect(result.value).toMatchObject({
          exit_code: 17,
          signal: null,
          stdout: "owned fixture stdout",
        });
        expect(Buffer.byteLength(result.value.stderr)).toBe(bytes);
        return;
      }
      if (!overflow) {
        if (result.ok) throw new Error("Expected late caller cancellation");
        const primary = primaryAnalysisError(
          result.error as Parameters<typeof primaryAnalysisError>[0],
        );
        expect(primary).toMatchObject({
          _tag: "AnalysisCancelledError",
          capturedOutput: {
            exit_code: 17,
            signal: null,
            stdout: "owned fixture stdout",
            truncated: false,
          },
          cleanupIncomplete: false,
        });
        expect(primary.cause).toBe(reason);
        expect(Buffer.byteLength(primary.capturedOutput!.stderr)).toBe(bytes);
        return;
      }
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisOutputError",
          capturedOutput: { truncated: true },
          cleanupIncomplete: false,
        },
      });
      if (result.ok) throw new Error("Expected diagnostic overflow refusal");
      const primary = primaryAnalysisError(
        result.error as Parameters<typeof primaryAnalysisError>[0],
      );
      expect(Buffer.byteLength(primary.capturedOutput!.stderr)).toBe(
        RECOVERY_LIMITS.reportBytes,
      );
      expect(
        primary.secondaryFailures.some(
          (failure) =>
            failure instanceof AnalysisCancelledError &&
            failure.cause === reason,
        ),
      ).toBe(true);
    } finally {
      if (spawned !== undefined) {
        const cleanup = await cleanupOwnedProcessGroup(spawned.ownership);
        expect(cleanup.cleaned).toBe(true);
      }
    }
  },
);
