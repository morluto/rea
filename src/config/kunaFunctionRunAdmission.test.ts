import { setImmediate } from "node:timers/promises";

import { expect, it } from "vitest";

import { runWithAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import type { KunaConfiguration } from "../kuna/KunaConfiguration.js";
import { KunaRunSlots } from "../kuna/KunaRunSlots.js";
import { reserveKunaFunctionRun } from "../kuna/KunaSessionClient.js";

const configuration = {
  command: "/usr/bin/kuna",
  cacheRoot: "/tmp/kuna-cache",
  cacheMaxBytes: 4 * 1024 ** 3,
  projectTimeoutMs: 30 * 60 * 1000,
  projectTimeoutSource: "default",
  projectTimeoutLaunchValid: true,
  functionTimeoutMs: 120_000,
  functionTimeoutSource: "default",
  functionTimeoutLaunchValid: false,
  jobs: 1,
} satisfies KunaConfiguration;

it("does not take a run slot when the function deadline is no longer valid", async () => {
  const slots = new KunaRunSlots(1);
  const signal = new AbortController().signal;
  await expect(
    reserveKunaFunctionRun(slots, signal, configuration),
  ).rejects.toThrow(
    /REA_KUNA_TIMEOUT_MS is not a valid launch seed and no runtime override is active/,
  );
  const released = await slots.acquire(AbortSignal.timeout(50));
  expect(released).toEqual(expect.any(Function));
  released?.();
});

it("releases the function-run slot after the accepted deadline is finished", async () => {
  const slots = new KunaRunSlots(1);
  const signal = new AbortController().signal;
  const reserved = await runWithAnalysisOperationSnapshot(
    {
      revision: 1,
      overrides: { "kuna.function_timeout_ms": 5000 },
    },
    () => reserveKunaFunctionRun(slots, signal, configuration),
  );
  expect(reserved?.deadline).toEqual({
    setting: "REA_KUNA_TIMEOUT_MS",
    ms: 5000,
    source: "runtime",
  });
  const next = slots.acquire(AbortSignal.timeout(50));
  let granted = false;
  void next.then((release) => {
    granted = release !== undefined;
  });
  await setImmediate();
  expect(granted).toBe(false);
  reserved?.release();
  expect(await next).toEqual(expect.any(Function));
  (await next)?.();
});
