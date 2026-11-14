import {
  access,
  chmod,
  mkdir,
  readdir,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { fakeAgentEnvSolves } from "../../tests/fixtures/fakeAgentEnvSolves.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import { spawnOwnedProviderProcess } from "../process/ProviderProcess.js";
import {
  runSolveHelper,
  type SolveCleanupOwner,
} from "./AgentEnvSolveHelper.js";

const SOLVE = { outcome: "passed" as const, checks: {}, turns: 3, usd: 0.1 };

const until = async (path: string, signal: AbortSignal) => {
  for (;;) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await delay(50, undefined, { signal });
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
    const polling = new AbortController();
    const retained: SolveCleanupOwner[] = [];
    const started = until(
      join(runner.environment.FAKE_STATE ?? "", "solves.jsonl"),
      polling.signal,
    );
    void started.catch(() => undefined);
    const begun = Date.now();

    const solved = runSolveHelper({
      ...(await options(environment)),
      signal: stop.signal,
      retainCleanup: (owner) => retained.push(owner),
      timing: { solveMs: 60_000, stopMs: 300 },
    });

    // agentenv keeps a sandbox's folder until its teardown is confirmed, so the
    // emptied private root shows nothing is left up: only the cancellation remains.
    try {
      await awaitAcknowledgement(started, solved, "solve helper start");
      stop.abort(new Error("cancelled by the test"));
      const failure: unknown = await solved.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("cancelled by the test");
      expect(failure).not.toHaveProperty("cleanupIncomplete", true);
      expect(retained).toHaveLength(0);
      expect(Date.now() - begun).toBeLessThan(15_000);
    } finally {
      polling.abort();
      stop.abort();
      await Promise.allSettled([started, solved]);
    }
  });

  it("records a helper stopped at its deadline without a report as a failed solve of unknown cost, its cleanup known", async () => {
    const runner = await fakeAgentEnvSolves([SOLVE]);
    const environment = { ...runner.environment, FAKE_SOLVE_HANGS: "1" };
    const retained: SolveCleanupOwner[] = [];

    const report = await runSolveHelper({
      ...(await options(environment)),
      signal: new AbortController().signal,
      retainCleanup: (owner) => retained.push(owner),
      timing: { solveMs: 1_000, stopMs: 300 },
    });

    expect(report).toMatchObject({
      outcome: "failed",
      usd: null,
      turns: null,
      checks: [],
      cleanup: { unknown: false, sandboxes: [] },
    });
    expect(report.error).toMatch(/stopped \(SIG[A-Z]+\) without a report/u);
    expect(retained).toHaveLength(0);
  });

  it("keeps a helper whose cleanup failed, so closing can retry it, and reports what is left", async () => {
    const runner = await fakeAgentEnvSolves([SOLVE]);
    const retained: SolveCleanupOwner[] = [];
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
    expect(failure).toMatchObject({
      report: { outcome: "passed", turns: 3, usd: 0.1 },
      diagnostics: { solve_report: { outcome: "passed", turns: 3, usd: 0.1 } },
    });
    expect(retained).toHaveLength(1);
    expect(await retained[0]?.stop()).toMatchObject({
      status: "verified-cleanup",
    });
    retained[0]?.dispose();
  });
});

it("retains a reported sandbox on failed removal, then retries that exact sandbox", async () => {
  const runner = await fakeAgentEnvSolves([SOLVE]);
  const root = await createTestTempDirectory("solve-sandbox-cleanup-");
  const docker = join(root, "docker");
  const permit = join(root, "permit");
  await writeFile(
    docker,
    `#!/bin/sh\nif [ "$1" = ps ]; then echo owned-container; exit 0; fi\n[ -f "$FAKE_CLEANUP_PERMIT" ]\n`,
  );
  await chmod(docker, 0o755);
  const retained: SolveCleanupOwner[] = [];
  const failure = await runSolveHelper({
    ...(await options({
      ...runner.environment,
      REA_DOCKER_COMMAND: docker,
      FAKE_CLEANUP_PERMIT: permit,
      FAKE_SOLVE_STILL_UP: '["local-owned"]',
    })),
    signal: new AbortController().signal,
    retainCleanup: (owner) => retained.push(owner),
  }).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ProviderCleanupError);
  if (!(failure instanceof ProviderCleanupError)) throw failure;
  expect(failure).toMatchObject({
    cleanupResources: ["agentenv sandbox local-owned"],
    report: { outcome: "passed", turns: 3, usd: 0.1 },
  });
  expect(retained).toHaveLength(1);
  await writeFile(permit, "allowed");
  expect(await retained[0]?.stop()).toMatchObject({
    status: "verified-cleanup",
  });
  expect(failure.cleanupIncomplete).toBe(false);
  expect(failure.cleanupResources).toEqual([]);
  retained[0]?.dispose();
});

it("retains a completed report if cancellation arrives during final cleanup", async () => {
  const runner = await fakeAgentEnvSolves([SOLVE]);
  const controller = new AbortController();
  const reason = { stage: "final cleanup" };
  const failure = await runSolveHelper({
    ...(await options(runner.environment)),
    signal: controller.signal,
    retainCleanup: () => undefined,
    spawn: async (spawnOptions) => {
      const owned = await spawnOwnedProviderProcess(spawnOptions);
      return {
        ...owned,
        cleanup: async () => {
          const result = await cleanupOwnedProcessGroup(owned.ownership);
          controller.abort(reason);
          return result;
        },
      };
    },
  }).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    _tag: "AnalysisCancelledError",
    cause: reason,
    report: { outcome: "passed", turns: 3, usd: 0.1 },
  });
});

it("retains an unrecognized sandbox root entry and retries after it is repaired", async () => {
  const runner = await fakeAgentEnvSolves([SOLVE]);
  const parent = await createTestTempDirectory("solve-owned-roots-");
  const retained: SolveCleanupOwner[] = [];
  const failure = await runSolveHelper({
    ...(await options({
      ...runner.environment,
      AGENT_ENV_LOCAL_SANDBOX_DIR: parent,
      FAKE_SOLVE_ROOT_ENTRY: "unexpected",
    })),
    signal: new AbortController().signal,
    retainCleanup: (owner) => retained.push(owner),
  }).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ProviderCleanupError);
  expect(retained).toHaveLength(1);
  const roots = await readdir(parent);
  expect(roots).toHaveLength(1);
  const root = join(parent, roots[0] ?? "");
  expect(await readdir(root)).toEqual(["unexpected"]);
  await rmdir(join(root, "unexpected"));
  expect(await retained[0]?.stop()).toMatchObject({
    status: "verified-cleanup",
  });
  expect(await readdir(parent)).toEqual([]);
  if (!(failure instanceof ProviderCleanupError)) throw failure;
  expect(failure.cleanupIncomplete).toBe(false);
  retained[0]?.dispose();
});

it("retains root cleanup and the spawn failure when admission fails", async () => {
  const runner = await fakeAgentEnvSolves([SOLVE]);
  const parent = await createTestTempDirectory("solve-spawn-root-");
  const retained: SolveCleanupOwner[] = [];
  const failure = await runSolveHelper({
    ...(await options({
      ...runner.environment,
      AGENT_ENV_LOCAL_SANDBOX_DIR: parent,
    })),
    signal: new AbortController().signal,
    retainCleanup: (owner) => retained.push(owner),
    spawn: async (spawnOptions) => {
      const root = spawnOptions.env?.AGENT_ENV_LOCAL_SANDBOX_DIR;
      if (root === undefined) throw new Error("missing root");
      await mkdir(join(root, "unexpected"));
      throw new Error("admission failed");
    },
  }).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ProviderCleanupError);
  if (!(failure instanceof ProviderCleanupError)) throw failure;
  expect(failure.diagnostics).toMatchObject({
    spawn_error: "admission failed",
  });
  expect(retained).toHaveLength(1);
  const roots = await readdir(parent);
  await rmdir(join(parent, roots[0] ?? "", "unexpected"));
  expect(await retained[0]?.stop()).toMatchObject({
    status: "verified-cleanup",
  });
  expect(failure.cleanupIncomplete).toBe(false);
  expect(failure.cleanupResources).toEqual([]);
  retained[0]?.dispose();
});
