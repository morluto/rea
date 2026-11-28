import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";

import {
  awaitApktoolOperation,
  createApktoolProcessFixture,
} from "../../fixtures/apktoolProcessTree.js";
import {
  observePosixProcess,
  waitForPosixObservation,
} from "../../support/process/observePosixProcess.js";
import { ApktoolProvider } from "../../../src/apktool/ApktoolProvider.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const DECODE_TIMEOUT_MS = 2_500;

// Windows Job Object cleanup is a separate owned-command lane. This observes
// the POSIX process group the apktool decode launcher actually uses.
it.skipIf(process.platform === "win32")(
  "stops a hanging launcher and its pipe-holding child when the decode deadline elapses",
  async () => {
    const root = await createTestTempDirectory("rea-apktool-decode-deadline-");
    const fixture = await createApktoolProcessFixture(root, "decode");
    const apk = join(root, "probe.apk");
    await writeFile(apk, "apk-bytes");
    const provider = new ApktoolProvider({
      environment: { REA_APKTOOL_COMMAND: fixture.command },
    });
    const started = performance.now();
    const pending = provider.execute({
      operation: "decode_android_resources",
      input: {
        path: apk,
        include_strings: false,
        decode_timeout_ms: DECODE_TIMEOUT_MS,
      },
    });
    try {
      const launched = await waitForPosixObservation(
        async () => {
          const marker = await fixture.readMarker();
          if (marker?.ready !== true) return undefined;
          const pids = [marker.rootPid, marker.childPid];
          return (await Promise.all(pids.map(observePosixProcess))).every(
            ({ kind }) => kind === "running",
          )
            ? pids
            : undefined;
        },
        { interval: 25 },
      );
      const outcome = await awaitApktoolOperation(pending, 15_000);
      const elapsed = performance.now() - started;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.cleanupIncomplete).toBe(false);
      const projected = projectAnalysisError(outcome.error);
      expect(projected).toMatchObject({
        code: "provider_timeout",
        details: {
          timeout_ms: DECODE_TIMEOUT_MS,
          limit: {
            control_kind: "parameter",
            parameter: "decode_timeout_ms",
            effective_value: DECODE_TIMEOUT_MS,
            unit: "ms",
            applies_at: "next_call",
          },
        },
      });
      // Settlement includes the owned-command deadline, so the timer elapsed.
      expect(elapsed).toBeGreaterThanOrEqual(DECODE_TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(15_000);
      await waitForPosixObservation(
        async () =>
          (await Promise.all(launched.map(observePosixProcess))).every(
            ({ kind }) => kind !== "running",
          )
            ? true
            : undefined,
        { interval: 25 },
      );
    } finally {
      await fixture.cleanup([pending, provider.close()]);
    }
  },
);
