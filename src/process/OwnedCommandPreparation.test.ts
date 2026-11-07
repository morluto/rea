import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../tests/fixtures/binarySession.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { DarwinProcessOwnershipInspectionError } from "./DarwinProcessRunTokenReader.js";
import {
  OwnedCommandFailure,
  prepareOwnedCommand,
  prepareOwnedCommandLaunch,
  runOwnedCommand,
} from "./OwnedCommand.js";
import {
  prepareProcessOwnershipInspection,
  systemProcessOwnershipHost,
} from "./ProcessOwnershipObservation.js";
import {
  prepareOwnedProviderProcess,
  type OwnedProviderProcessSpawnOptions,
} from "./ProviderProcess.js";

const platform = Object.getOwnPropertyDescriptor(
  systemProcessOwnershipHost,
  "platform",
)!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(systemProcessOwnershipHost, "platform", platform);
  vi.useRealTimers();
});
const hostPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(systemProcessOwnershipHost, "platform", {
    value,
    configurable: true,
  });

it("gives bounded macOS preparation the caller signal and no command deadline", async () => {
  hostPlatform("darwin");
  vi.useFakeTimers();
  const prepared = createDeferred<void>();
  const controller = new AbortController();
  const prepare = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockImplementation(async (signal) => {
      expect(signal).toBe(controller.signal);
      await prepared.promise;
    });
  let completed = false;
  const pending = prepareOwnedCommand(controller.signal).then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(completed).toBe(false);
  expect(controller.signal.aborted).toBe(false);
  prepared.resolve();
  await pending;
  expect(prepare).toHaveBeenCalledOnce();
});

it.each(["linux", "win32"] as const)(
  "leaves %s preparation inside the command deadline",
  async (value) => {
    hostPlatform(value);
    const prepare = vi.spyOn(systemProcessOwnershipHost, "prepare");
    await prepareOwnedCommand();
    expect(prepare).not.toHaveBeenCalled();
  },
);

it("keeps an observed compiler failure primary when cancellation is also observed", async () => {
  hostPlatform("darwin");
  const failure = new DarwinProcessOwnershipInspectionError(
    "physical compiler failure",
  );
  const controller = new AbortController();
  vi.spyOn(systemProcessOwnershipHost, "prepare").mockImplementation(
    async () => {
      controller.abort({ caller: "after compiler failure" });
      throw failure;
    },
  );
  await expect(prepareOwnedCommand(controller.signal)).rejects.toBe(failure);
});

it.each(["before", "during"] as const)(
  "does not reinterpret a typed opaque caller reason as a helper failure: %s",
  async (phase) => {
    hostPlatform("darwin");
    const reason = new DarwinProcessOwnershipInspectionError(
      "caller-owned reason",
    );
    const controller = new AbortController();
    const prepare = vi
      .spyOn(systemProcessOwnershipHost, "prepare")
      .mockImplementation(async () => {
        controller.abort(reason);
        throw reason;
      });
    if (phase === "before") controller.abort(reason);
    let observed: unknown;
    try {
      await prepareOwnedCommand(controller.signal);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(OwnedCommandFailure);
    if (!(observed instanceof OwnedCommandFailure)) throw observed;
    expect(observed.reason).toBe("cancelled");
    expect(observed.cancellation?.reason).toBe(reason);
    expect(observed.preparationFailure).toBeUndefined();
    expect(prepare).toHaveBeenCalledTimes(phase === "before" ? 0 : 1);
  },
);

it("preserves exact cancelled preparation cleanup capabilities", async () => {
  hostPlatform("darwin");
  const reason = { caller: "during helper final cleanup" };
  const controller = new AbortController();
  const cleanup = new ProviderCleanupError(
    "process-ownership",
    ["authored-owned-helper"],
    {},
  );
  const owner = {
    close: vi.fn(async () => {
      cleanup.resolveCleanup();
    }),
  };
  const failure = new DarwinProcessOwnershipInspectionError(
    "cancelled helper",
    { cancellation: { reason }, cleanupFailure: cleanup, cleanupOwner: owner },
  );
  vi.spyOn(systemProcessOwnershipHost, "prepare").mockImplementation(
    async () => {
      controller.abort(reason);
      throw failure;
    },
  );
  let observed: unknown;
  try {
    await prepareOwnedCommand(controller.signal);
  } catch (error) {
    observed = error;
  }
  if (!(observed instanceof OwnedCommandFailure)) throw observed;
  expect(observed.cancellation?.reason).toBe(reason);
  expect(observed.preparationFailure).toBe(failure);
  if (observed.preparationFailure === undefined)
    throw new Error("Expected retained preparation failure");
  expect(observed.preparationFailure.cleanupOwner).toBe(owner);
  expect(observed.preparationFailure.cleanupFailure).toBe(cleanup);
  await observed.preparationFailure.cleanupOwner!.close();
  expect(cleanup.cleanupIncomplete).toBe(false);
});

it("bounds simulated Linux preparation by the command deadline before launch", async () => {
  hostPlatform("linux");
  vi.useFakeTimers();
  const preparing = vi
    .spyOn(systemProcessOwnershipHost, "prepare")
    .mockImplementation(async (signal) => {
      await new Promise<void>((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    });
  await prepareOwnedCommand();
  expect(preparing).not.toHaveBeenCalled();
  let enteredLaunch = false;
  const pending = runOwnedCommand(
    {
      command: "never-launched",
      arguments: [],
      runId: "authored-linux-prepare",
    },
    { timeoutMs: 50, diagnosticBytes: 1024 },
    {
      launcher: async (input) => {
        await prepareProcessOwnershipInspection(input.signal);
        enteredLaunch = true;
        throw new Error("Preparation should time out before launch");
      },
    },
  );
  const expected = expect(pending).rejects.toMatchObject({
    reason: "timeout",
    message: "Command deadline elapsed during ownership preparation.",
  });
  await vi.advanceTimersByTimeAsync(51);
  await expected;
  expect(enteredLaunch).toBe(false);
});

it.each([false, true])(
  "keeps no-deadline preparation pending without a timer (caller signal: %s)",
  async (withCallerSignal) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const prepared = createDeferred<void>();
    const failure = new Error("authored preparation failure");
    let preparationSignal: AbortSignal | undefined;
    const pending = runOwnedCommand(
      {
        command: "never-launched",
        arguments: [],
        runId: "authored-no-deadline-prepare",
      },
      { timeoutMs: null, diagnosticBytes: 1024 },
      {
        ...(withCallerSignal ? { signal: controller.signal } : {}),
        launcher: async (input) => {
          preparationSignal = input.signal;
          await prepared.promise;
          throw failure;
        },
      },
    );
    const expected = expect(pending).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(preparationSignal?.aborted).toBe(false);
    if (withCallerSignal) expect(preparationSignal).toBe(controller.signal);
    expect(vi.getTimerCount()).toBe(0);
    prepared.resolve();
    await expected;
  },
);

it("cancels no-deadline preparation with the caller's exact opaque reason", async () => {
  const controller = new AbortController();
  const reason = new DarwinProcessOwnershipInspectionError(
    "opaque caller reason",
  );
  const started = createDeferred<void>();
  const pending = runOwnedCommand(
    {
      command: "never-launched",
      arguments: [],
      runId: "authored-no-deadline-cancel",
    },
    { timeoutMs: null, diagnosticBytes: 1024 },
    {
      signal: controller.signal,
      launcher: async (input) => {
        expect(input.signal).toBe(controller.signal);
        started.resolve();
        await new Promise<void>((_resolve, reject) =>
          input.signal?.addEventListener(
            "abort",
            () => reject(input.signal?.reason),
            {
              once: true,
            },
          ),
        );
        throw new Error("Cancelled preparation must not launch");
      },
    },
  );
  const expected = expect(pending).rejects.toMatchObject({
    reason: "cancelled",
    cancellation: { reason },
    preparationFailure: undefined,
    snapshot: null,
  });
  await started.promise;
  controller.abort(reason);
  await expected;
});

it("allows baseline preparation to finish before a short command deadline", async () => {
  hostPlatform("darwin");
  vi.spyOn(systemProcessOwnershipHost, "prepare").mockResolvedValue();
  const baseline = [{ pid: 101, identity: "darwin-start:before" }];
  vi.spyOn(systemProcessOwnershipHost, "captureBaseline").mockImplementation(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return baseline;
    },
  );
  const spawn: OwnedProviderProcessSpawnOptions = {
    command: "not-launched",
    arguments: [],
    runId: "authored-prepared-baseline",
    sweepTokenOwnedProcesses: true,
  };
  const prepared = await prepareOwnedProviderProcess(spawn);
  expect(prepared.captureBaseline).toEqual(baseline);
  const pending = runOwnedCommand(
    { ...spawn, preparedOwnership: prepared },
    { timeoutMs: 10, diagnosticBytes: 1024 },
    {
      launcher: async (input) => {
        expect(input.preparedOwnership).toBe(prepared);
        throw new Error("after prepared baseline");
      },
    },
  );
  await expect(pending).rejects.toThrow("after prepared baseline");
});

it("preserves caller cancellation during early Darwin baseline preparation", async () => {
  hostPlatform("darwin");
  const controller = new AbortController();
  const reason = { request: "cancel-baseline" };
  vi.spyOn(systemProcessOwnershipHost, "prepare").mockResolvedValue();
  vi.spyOn(systemProcessOwnershipHost, "captureBaseline").mockImplementation(
    async () => {
      controller.abort(reason);
      throw reason;
    },
  );
  let failure: unknown;
  try {
    await prepareOwnedCommandLaunch(
      {
        command: "unused",
        arguments: [],
        runId: "baseline-cancel",
        platform: "darwin",
        sweepTokenOwnedProcesses: true,
      },
      controller.signal,
    );
  } catch (cause) {
    failure = cause;
  }
  expect(failure).toBeInstanceOf(OwnedCommandFailure);
  if (!(failure instanceof OwnedCommandFailure)) throw failure;
  expect(failure.reason).toBe("cancelled");
  expect(failure.cancellation?.reason).toBe(reason);
});

it("does not move Linux baseline capture outside the command deadline", async () => {
  hostPlatform("linux");
  const capture = vi.spyOn(systemProcessOwnershipHost, "captureBaseline");
  await prepareOwnedCommandLaunch({
    command: "unused",
    arguments: [],
    runId: "linux-baseline",
    platform: "linux",
    sweepTokenOwnedProcesses: true,
  });
  expect(capture).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== "darwin")(
  "reuses the prepared baseline in the default owned launcher",
  async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const original = systemProcessOwnershipHost.captureBaseline;
    if (original === undefined)
      throw new Error("Expected Darwin baseline support");
    const capture = vi
      .spyOn(systemProcessOwnershipHost, "captureBaseline")
      .mockImplementation(async (signal) => {
        entered.resolve();
        await release.promise;
        return original(signal);
      });
    const spawn: OwnedProviderProcessSpawnOptions = {
      command: process.execPath,
      arguments: ["-e", "process.stdout.write('ready')"],
      runId: "rea-baseline-reuse-test",
      sweepTokenOwnedProcesses: true,
    };
    try {
      const preparation = prepareOwnedCommandLaunch(spawn);
      await entered.promise;
      release.resolve();
      const prepared = await preparation;
      if (prepared === undefined)
        throw new Error("Expected Darwin preparation");
      const result = await runOwnedCommand(
        { ...spawn, preparedOwnership: prepared },
        { timeoutMs: 10_000, diagnosticBytes: 1024 },
      );
      expect(result.stdout.text).toBe("ready");
      expect(capture).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
    }
  },
  30_000,
);

it("retains baseline cleanup ownership when cancellation arrives during preparation", async () => {
  hostPlatform("darwin");
  const reason = { request: "cancel-during-baseline-cleanup" };
  const controller = new AbortController();
  const cleanup = new ProviderCleanupError(
    "process-ownership",
    ["baseline-helper"],
    {},
  );
  const owner = {
    close: vi.fn(async () => {
      cleanup.resolveCleanup();
    }),
  };
  const physical = new DarwinProcessOwnershipInspectionError(
    "baseline cleanup incomplete",
    {
      cancellation: { reason },
      cleanupFailure: cleanup,
      cleanupOwner: owner,
    },
  );
  vi.spyOn(systemProcessOwnershipHost, "prepare").mockResolvedValue();
  vi.spyOn(systemProcessOwnershipHost, "captureBaseline").mockImplementation(
    async () => {
      controller.abort(reason);
      throw physical;
    },
  );
  let failure: unknown;
  try {
    await prepareOwnedCommandLaunch(
      {
        command: "unused",
        arguments: [],
        runId: "baseline-cleanup",
        platform: "darwin",
        sweepTokenOwnedProcesses: true,
      },
      controller.signal,
    );
  } catch (cause) {
    failure = cause;
  }
  if (!(failure instanceof OwnedCommandFailure)) throw failure;
  expect(failure.cancellation?.reason).toBe(reason);
  expect(failure.preparationFailure?.cleanupOwner).toBe(owner);
  expect(failure.preparationFailure?.cleanupFailure).toBe(cleanup);
  await owner.close();
  expect(cleanup.cleanupIncomplete).toBe(false);
});

it("times out stalled Linux baseline capture before the default launcher starts a child", async () => {
  hostPlatform("linux");
  vi.useFakeTimers();
  vi.spyOn(systemProcessOwnershipHost, "prepare").mockResolvedValue();
  const entered = createDeferred<void>();
  vi.spyOn(systemProcessOwnershipHost, "captureBaseline").mockImplementation(
    async (signal) => {
      entered.resolve();
      return await new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  );
  const spawn: OwnedProviderProcessSpawnOptions = {
    command: "never-launched",
    arguments: [],
    runId: "linux-stalled-baseline",
    platform: "linux",
    sweepTokenOwnedProcesses: true,
  };
  expect(await prepareOwnedCommandLaunch(spawn)).toBeUndefined();
  const pending = runOwnedCommand(spawn, {
    timeoutMs: 50,
    diagnosticBytes: 1024,
  });
  const outcome = pending.then(
    () => {
      throw new Error("Expected timeout");
    },
    (cause: unknown) => cause,
  );
  await entered.promise;
  await vi.advanceTimersByTimeAsync(50);
  expect(await outcome).toMatchObject({ reason: "timeout" });
});

it("bounds a stalled Darwin baseline without charging helper preparation to the baseline budget", async () => {
  hostPlatform("darwin");
  vi.useFakeTimers();
  const preparation = createDeferred<void>();
  const entered = createDeferred<void>();
  vi.spyOn(systemProcessOwnershipHost, "prepare").mockImplementation(
    async () => preparation.promise,
  );
  vi.spyOn(systemProcessOwnershipHost, "captureBaseline").mockImplementation(
    async (signal) => {
      entered.resolve();
      return await new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  );
  const pending = prepareOwnedCommandLaunch({
    command: "never-launched",
    arguments: [],
    runId: "darwin-stalled",
    platform: "darwin",
    sweepTokenOwnedProcesses: true,
  });
  const outcome = pending.then(
    () => {
      throw new Error("Expected timeout");
    },
    (cause: unknown) => cause,
  );
  await vi.advanceTimersByTimeAsync(20_000);
  preparation.resolve();
  await entered.promise;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await outcome).toMatchObject({ reason: "timeout" });
});
