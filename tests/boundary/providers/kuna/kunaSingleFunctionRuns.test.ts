import { expect, it as test, vi } from "vitest";
import { runWithAnalysisOperationSnapshot } from "../../../../src/domain/analysisOperationSnapshot.js";
import { awaitAcknowledgement } from "../../../fixtures/lifecycleAcknowledgement.js";
import { KunaRunSlots } from "../../../../src/kuna/KunaRunSlots.js";

import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import type { KunaProcessLauncher } from "../../../../src/kuna/KunaCommand.js";
import { KunaProjectCache } from "../../../../src/kuna/KunaProjectCache.js";
import { spawnOwnedProviderProcess } from "../../../../src/process/ProviderProcess.js";

import {
  fakeKunaCalls,
  fakeKunaExits,
  releaseFakeKunaCommand,
  setFakeKunaBehavior,
} from "./fakeKuna.js";
import {
  FUNCTIONS,
  run,
  session,
  unprovenCleanupLauncher,
  awaitKunaCommand,
} from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");

const decompilesOf = async (kuna: string) =>
  (await fakeKunaCalls(kuna)).filter(({ argv }) => argv[0] === "decompile");

it("shares one single-function run among concurrent requests for one entry", async () => {
  const { kuna, open } = await session("rea-kuna-single-shared-", {
    project: "hang",
    decompileDelayMs: 300,
  });
  const client = open();
  try {
    const answers = await Promise.all(
      ["main", "main", "0x1000"].map((procedure) =>
        run(client, "procedure_pseudo_code", { procedure }),
      ),
    );
    for (const answer of answers)
      expect(answer).toMatchObject({
        result: "int main(void) // single-function\n{\n  return 0;\n}",
        rawResult: { source: { kind: "single-function" } },
      });
    expect(await decompilesOf(kuna)).toHaveLength(1);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("keeps a shared run for the callers still waiting when one cancels", async () => {
  const { kuna, open } = await session("rea-kuna-single-cancel-", {
    project: "hang",
    gatedCommands: ["decompile"],
  });
  const client = open();
  const caller = new AbortController();
  const leaving = client.execute(
    "procedure_pseudo_code",
    { procedure: "main" },
    { signal: caller.signal },
  );
  const staying = client.execute("procedure_pseudo_code", {
    procedure: "main",
  });
  try {
    await awaitKunaCommand(kuna, "decompile", Promise.all([leaving, staying]));
    caller.abort();
    expect(await leaving).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    await releaseFakeKunaCommand(kuna, "decompile");
    const completed = await staying;
    if (!completed.ok) throw completed.error;
    expect(completed.value.rawResult).toMatchObject({
      source: { kind: "single-function" },
    });
    const [call] = await decompilesOf(kuna);
    expect((await fakeKunaExits(kuna)).has(call?.pid ?? 0)).toBe(true);
    expect(await decompilesOf(kuna)).toHaveLength(1);
  } finally {
    caller.abort();
    await releaseFakeKunaCommand(kuna, "decompile");
    const closed = await client.close();
    await Promise.allSettled([leaving, staying]);
    expect(closed).toEqual({ ok: true, value: null });
  }
});

it("admits no more concurrent single-function runs than its slots", async () => {
  const { kuna, open } = await session(
    "rea-kuna-single-slots-",
    { project: "hang", decompileDelayMs: 200 },
    {},
    undefined,
    1,
  );
  const client = open();
  try {
    await Promise.all(
      ["main", "parse"].map((procedure) =>
        run(client, "procedure_pseudo_code", { procedure }),
      ),
    );
    const [first, second] = [...(await decompilesOf(kuna))].sort(
      (left, right) => left.at - right.at,
    );
    const exits = await fakeKunaExits(kuna);
    if (first === undefined || second === undefined)
      throw new Error("Expected both single-function runs");
    const firstExit = exits.get(first.pid);
    expect(firstExit).toBeDefined();
    if (firstExit === undefined) throw new Error("Missing first process exit");
    // The second run starts only after the first one's process finished.
    expect(second.at).toBeGreaterThanOrEqual(firstExit);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("answers a queued request from the export once it finishes first", async () => {
  const { kuna, open } = await session(
    "rea-kuna-single-yield-",
    { gatedCommands: ["decompile-project"], decompile: "hang" },
    {},
    undefined,
    1,
  );
  const client = open();
  const holder = new AbortController();
  const admission = deferred<void>();
  const acquire = KunaRunSlots.prototype.acquire;
  let arrivals = 0;
  const requests = vi
    .spyOn(KunaRunSlots.prototype, "acquire")
    .mockImplementation(function (this: KunaRunSlots, signal) {
      const pending = acquire.call(this, signal);
      if (++arrivals === 2) admission.resolve();
      return pending;
    });
  let queued: ReturnType<typeof client.execute> | undefined;
  // This run holds the only slot until its caller leaves.
  const holding = client.execute(
    "procedure_pseudo_code",
    { procedure: "main" },
    { signal: holder.signal },
  );
  try {
    await awaitKunaCommand(kuna, "decompile", holding);
    queued = client.execute("procedure_pseudo_code", { procedure: "parse" });
    await awaitAcknowledgement(
      admission.promise,
      queued,
      "queued single-function admission",
    );
    await releaseFakeKunaCommand(kuna, "decompile-project");
    const completed = await queued;
    if (!completed.ok) throw completed.error;
    expect(completed.value).toMatchObject({
      result: "int parse(void)\n{\n  return 1;\n}",
      rawResult: { source: { kind: "project-export" } },
    });
    expect(await decompilesOf(kuna)).toHaveLength(1);
    holder.abort();
    expect(await holding).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  } finally {
    holder.abort();
    await releaseFakeKunaCommand(kuna, "decompile-project");
    const closed = await client.close();
    await Promise.allSettled([holding, queued]);
    requests.mockRestore();
    expect(closed).toEqual({ ok: true, value: null });
  }
});

it("keeps the slot of a run whose stop is unproven until close proves it", async () => {
  const unproven = unprovenCleanupLauncher("decompile");
  const { kuna, open } = await session(
    "rea-kuna-single-retained-slot-",
    { project: "hang", decompile: "hang" },
    { REA_KUNA_TIMEOUT_MS: "10000" },
    unproven.launcher,
    1,
  );
  const client = open();
  const waiter = new AbortController();
  let queued: ReturnType<typeof client.execute> | undefined;
  let restoreAcquire: (() => void) | undefined;
  try {
    expect((await client.execute("list_procedures", {})).ok).toBe(true);
    expect(
      await runWithAnalysisOperationSnapshot(
        { revision: 1, overrides: { "kuna.function_timeout_ms": 300 } },
        () => client.execute("procedure_pseudo_code", { procedure: "main" }),
      ),
    ).toMatchObject({ ok: false, error: { cleanupIncomplete: true } });
    // The timed-out tree may still run, so the next run must not start.
    const admission = deferred<void>();
    const acquire = KunaRunSlots.prototype.acquire;
    let granted = false;
    const requests = vi
      .spyOn(KunaRunSlots.prototype, "acquire")
      .mockImplementation(function (this: KunaRunSlots, signal) {
        const pending = acquire.call(this, signal);
        void pending.then(() => {
          granted = true;
        });
        admission.resolve();
        return pending;
      });
    restoreAcquire = () => requests.mockRestore();
    queued = client.execute(
      "procedure_pseudo_code",
      { procedure: "parse" },
      { signal: waiter.signal },
    );
    await awaitAcknowledgement(
      admission.promise,
      queued,
      "retained single-function slot",
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(granted).toBe(false);
    expect(await decompilesOf(kuna)).toHaveLength(1);
    waiter.abort();
    expect(await queued).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    restoreAcquire();
    restoreAcquire = undefined;
    expect((await client.close()).ok).toBe(false);
    unproven.release();
    expect(await client.close()).toEqual({ ok: true, value: null });

    // The proven stop returns the slot to the provider.
    await setFakeKunaBehavior(kuna, { functions: FUNCTIONS, project: "hang" });
    const next = open();
    try {
      expect(
        (await run(next, "procedure_pseudo_code", { procedure: "parse" }))
          .rawResult,
      ).toMatchObject({ source: { kind: "single-function" } });
    } finally {
      expect(await next.close()).toEqual({ ok: true, value: null });
    }
  } finally {
    waiter.abort();
    unproven.release();
    await client.close();
    await Promise.allSettled([queued]);
    restoreAcquire?.();
  }
});

it("answers a repeated request from the completed run while the export builds", async () => {
  const { kuna, open } = await session("rea-kuna-single-kept-", {
    project: "hang",
  });
  const client = open();
  try {
    const first = await run(client, "procedure_pseudo_code", {
      procedure: "main",
    });
    // A repeat by name or by address reuses the text; no run re-analyzes.
    for (const procedure of ["main", "0x1000"])
      expect(
        await run(client, "procedure_pseudo_code", { procedure }),
      ).toMatchObject({
        result: first.result,
        rawResult: { source: { kind: "single-function" } },
      });
    expect(await decompilesOf(kuna)).toHaveLength(1);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("keeps answering repeats from the completed run after the export fails", async () => {
  const { kuna, open } = await session("rea-kuna-single-kept-failed-", {
    project: "exit-failure",
  });
  const client = open();
  try {
    expect(
      await client.execute("procedure_assembly", { procedure: "main" }),
    ).toMatchObject({ ok: false, error: { retryable: false } });
    for (let repeat = 0; repeat < 2; repeat += 1) {
      const answer = await run(client, "procedure_pseudo_code", {
        procedure: "main",
      });
      expect(answer.rawResult).toMatchObject({
        source: { kind: "single-function" },
      });
      expect(answer.limitations).toContainEqual(
        expect.stringContaining("The project export failed"),
      );
      expect(answer.siblingUnavailability?.siblingOperations).toEqual([
        "procedure_assembly",
        "analyze_function",
      ]);
    }
    expect(await decompilesOf(kuna)).toHaveLength(1);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

it("reports sibling unavailability when fallback observes settled export failure without prior assembly call", async () => {
  const exportSettled = deferred<void>();
  exportSettled.promise.catch(() => undefined);
  const originalBuild = KunaProjectCache.prototype.build;
  const exportBuild = vi
    .spyOn(KunaProjectCache.prototype, "build")
    .mockImplementation(function (this: KunaProjectCache, ...args) {
      const promise = originalBuild.apply(this, args);
      return promise.finally(() => exportSettled.resolve());
    });
  const launcher: KunaProcessLauncher = async (options) => {
    if (options.arguments[0] === "decompile") {
      await exportSettled.promise;
    }
    return spawnOwnedProviderProcess(options);
  };
  const { kuna, open } = await session(
    "rea-kuna-single-fallback-unavail-",
    { project: "exit-failure" },
    {},
    launcher,
  );
  const client = open();
  try {
    const answer = await run(client, "procedure_pseudo_code", {
      procedure: "main",
    });
    expect(answer.rawResult).toMatchObject({
      source: { kind: "single-function" },
    });
    expect(answer.siblingUnavailability).toBeDefined();
    expect(answer.siblingUnavailability?.siblingOperations).toEqual([
      "procedure_assembly",
      "analyze_function",
    ]);
    expect(answer.siblingUnavailability?.providerId).toBe("kuna");
    expect(await decompilesOf(kuna)).toHaveLength(1);
    await exportSettled.promise;
  } finally {
    exportSettled.resolve();
    try {
      expect(await client.close()).toEqual({ ok: true, value: null });
    } finally {
      exportBuild.mockRestore();
    }
  }
});

it("does not keep a failed run, so a repeat runs again", async () => {
  const { kuna, open } = await session(
    "rea-kuna-single-failed-not-kept-",
    { project: "hang", decompile: "hang" },
    { REA_KUNA_TIMEOUT_MS: "10000" },
  );
  const client = open();
  try {
    expect((await client.execute("list_procedures", {})).ok).toBe(true);
    for (let repeat = 0; repeat < 2; repeat += 1)
      expect(
        await runWithAnalysisOperationSnapshot(
          { revision: 1, overrides: { "kuna.function_timeout_ms": 200 } },
          () => client.execute("procedure_pseudo_code", { procedure: "main" }),
        ),
      ).toMatchObject({ ok: false });
    expect(await decompilesOf(kuna)).toHaveLength(2);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("drops the least recently used text beyond the session's 16 MiB budget", async () => {
  // Two 6 MiB texts fit the budget and a third does not. Reading main again
  // makes parse the least recently used, so keeping broken drops parse.
  const { kuna, open } = await session("rea-kuna-single-kept-budget-", {
    project: "hang",
    decompilePadding: 6 * 1024 * 1024,
  });
  const client = open();
  try {
    for (const procedure of [
      "main",
      "parse",
      "main",
      "broken",
      "main",
      "parse",
    ])
      await run(client, "procedure_pseudo_code", { procedure });
    expect((await decompilesOf(kuna)).map(({ argv }) => argv[2])).toEqual([
      "0x1000",
      "0x1040",
      "0x1080",
      "0x1040",
    ]);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});

it("names the setting that owns a single-function deadline", async () => {
  const { open } = await session(
    "rea-kuna-function-deadline-",
    { project: "hang", decompile: "hang" },
    { REA_KUNA_TIMEOUT_MS: "10000" },
  );
  const client = open();
  try {
    expect((await client.execute("list_procedures", {})).ok).toBe(true);
    const result = await runWithAnalysisOperationSnapshot(
      { revision: 1, overrides: { "kuna.function_timeout_ms": 300 } },
      () => client.execute("procedure_pseudo_code", { procedure: "main" }),
    );
    if (result.ok) throw new Error("the hanging run answered");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "provider_timeout",
      details: {
        timeout_ms: 300,
        limit: {
          setting: "kuna.function_timeout_ms",
          effective_value: 300,
          update_mode: "runtime",
          pending_restart: false,
        },
      },
    });
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
});
