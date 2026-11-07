import { access } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { fakeAgentEnvSolves } from "../../tests/fixtures/fakeAgentEnvSolves.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  spawnOwnedProviderProcess,
  type ProviderProcessSupervisor,
} from "../process/ProviderProcess.js";
import { runSolveHelper } from "./AgentEnvSolveHelper.js";

const SOLVE = { outcome: "passed" as const, checks: {}, turns: 3, usd: 0.1 };

const until = async (path: string) => {
  for (;;) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

const options = async (environment: Readonly<Record<string, string>>) => ({
  bundle: await createTestTempDirectory("solve-bundle-"),
  task: "add-eggs",
  model: "m",
  agent: "claude-code",
  environment: { ...process.env, ...environment },
  operation: "measure_build_task",
});

describe("runSolveHelper", () => {
  it("stops a cancelled solve whose helper ignores SIGTERM within its stop grace", async () => {
    const runner = await fakeAgentEnvSolves([SOLVE]);
    const environment = { ...runner.environment, FAKE_SOLVE_HANGS: "1" };
    const stop = new AbortController();
    const started = until(
      join(runner.environment.FAKE_STATE ?? "", "solves.jsonl"),
    ).then(() => stop.abort(new Error("cancelled by the test")));
    const begun = Date.now();

    const solved = runSolveHelper({
      ...(await options(environment)),
      signal: stop.signal,
      retainCleanup: () => undefined,
      timing: { solveMs: 60_000, stopMs: 300 },
    });

    await expect(solved).rejects.toThrow("cancelled by the test");
    await started;
    expect(Date.now() - begun).toBeLessThan(15_000);
  }, 30_000);

  it("keeps a helper whose cleanup failed, so closing can retry it, and reports what is left", async () => {
    const runner = await fakeAgentEnvSolves([SOLVE]);
    const retained: ProviderProcessSupervisor[] = [];
    let cleanups = 0;

    const solved = runSolveHelper({
      ...(await options(runner.environment)),
      signal: new AbortController().signal,
      retainCleanup: (owner) => retained.push(owner),
      spawn: async (spawnOptions) => {
        const owned = await spawnOwnedProviderProcess(spawnOptions);
        return {
          ...owned,
          cleanup: async () => {
            cleanups += 1;
            const cleaned = await cleanupOwnedProcessGroup(owned.ownership);
            return cleanups === 1
              ? { cleaned: false as const, reason: "a refusal by the test" }
              : cleaned;
          },
        };
      },
    });

    const failure = await solved.catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ProviderCleanupError);
    expect(retained).toHaveLength(1);
    expect(await retained[0]?.stop()).toMatchObject({
      status: "verified-cleanup",
    });
    retained[0]?.dispose();
  }, 30_000);
});
