import { afterEach, expect, it, vi } from "vitest";
import { AdbUiRunner } from "./AdbUiRunner.js";
import * as commands from "../process/OwnedCommand.js";
import { DarwinProcessOwnershipInspectionError } from "../process/DarwinProcessRunTokenReader.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { adbUiInputSchemas } from "../domain/adb/adbUiAnalysis.js";
import { createDeferred } from "../../tests/fixtures/binarySession.js";
import { primaryAnalysisError } from "../domain/analysisErrorBase.js";

const request = {
  operation: "inspect_adb_ui" as const,
  input: adbUiInputSchemas.inspect_adb_ui.parse({
    serial: "emulator-5554",
    package: "com.example.app",
  }),
};
const client = {
  binary_path: "adb",
  path_source: "path" as const,
  version: null,
  installed_path: null,
};
const provider = { id: "adb", name: "ADB", version: null };
it.each([
  { environment: { PATH: "C:\\tools", PATHEXT: ".EXE" }, kind: "not_found" },
  {
    environment: { PATH: "C:\\tools", PATHEXT: ".EXE;C:\\bad" },
    kind: "invalid_extension",
  },
])(
  "refuses Windows executable selection before UI launch: $kind",
  async ({ environment, kind }) => {
    const launcher = vi.fn(async () => {
      throw new Error("must not launch an unresolved executable");
    });
    const runner = new AdbUiRunner(environment, launcher, "win32", () => false);
    const result = await runner.execute(request, "adb", client, provider);
    if (result.ok) throw new Error("Expected executable selection refusal");
    expect(result.error).toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
      diagnostics: { selected_binary: "adb", lookup_failure: kind },
    });
    expect(launcher).not.toHaveBeenCalled();
    expect(runner.pendingResources).toEqual([]);
    await runner.close();
  },
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("does not spend the short UI command deadline on cold ownership preparation", async () => {
  vi.useFakeTimers();
  const entered = createDeferred<void>();
  const ready = createDeferred<void>();
  const controller = new AbortController();
  vi.spyOn(commands, "prepareOwnedCommand").mockImplementation(
    async (signal) => {
      expect(signal).toBe(controller.signal);
      entered.resolve(undefined);
      await ready.promise;
    },
  );
  const launcher = vi.fn(async () => {
    throw new Error("controlled no-launch transport failure");
  });
  const runner = new AdbUiRunner({}, launcher, "linux");
  const pending = runner.execute(
    request,
    "adb",
    client,
    provider,
    controller.signal,
  );
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(88_000);
    expect(launcher).not.toHaveBeenCalled();
    expect(controller.signal.aborted).toBe(false);
    ready.resolve(undefined);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(launcher).toHaveBeenCalledOnce();
  } finally {
    ready.resolve(undefined);
    await pending;
    await runner.close();
  }
});

it.each([
  { stage: "prepare", cancelled: false },
  { stage: "prepare", cancelled: true },
  { stage: "launch", cancelled: false },
  { stage: "launch", cancelled: true },
])(
  "retains $stage preparation cleanup and retries the exact owner (cancelled: $cancelled)",
  async ({ stage, cancelled }) => {
    let denied = true;
    const close = vi.fn(async () => {
      if (denied) throw new Error("controlled helper removal denial");
    });
    const controller = new AbortController();
    const reason = { caller: "opaque cancellation" };
    const cleanup = new ProviderCleanupError("adb", ["owned-helper-root"], {
      reason: "helper removal denied",
    });
    const native = new DarwinProcessOwnershipInspectionError(
      "compiler failed with retained directory",
      {
        cleanupOwner: { close },
        cleanupFailure: cleanup,
        capturedOutput: {
          stdout: "compiler stdout",
          stderr: "compiler stderr",
          truncated: false,
        },
        ...(cancelled ? { cancellation: { reason } } : {}),
      },
    );
    const failPreparation = async (): Promise<never> => {
      if (cancelled) {
        controller.abort(reason);
        throw new commands.OwnedCommandFailure(
          "cancelled",
          "cancelled preparation",
          null,
          null,
          { preparationFailure: native, cancellation: { reason } },
        );
      }
      throw native;
    };
    vi.spyOn(commands, "prepareOwnedCommand").mockImplementation(async () => {
      if (stage === "prepare") await failPreparation();
    });
    const launcher = vi.fn(async () => {
      if (stage === "launch") return failPreparation();
      throw new Error("target must not launch");
    });
    const runner = new AdbUiRunner({}, launcher, "linux");
    try {
      const result = await runner.execute(
        request,
        "adb",
        client,
        provider,
        controller.signal,
      );
      if (result.ok) throw new Error("Expected preparation failure");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.capturedOutput).toEqual(native.capturedOutput);
      if (cancelled)
        expect(primaryAnalysisError(result.error).cause).toBe(reason);
      expect(runner.pendingResources).toContain("owned-helper-root");
      expect(native.cleanupOwner).toBeDefined();
      expect(launcher).toHaveBeenCalledTimes(stage === "launch" ? 1 : 0);
      await expect(runner.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
      });
      expect(runner.pendingResources).toContain("owned-helper-root");
      denied = false;
      const prior = close.mock.calls.length;
      await runner.close();
      await runner.close();
      expect(close).toHaveBeenCalledTimes(prior + 1);
      expect(runner.pendingResources).toEqual([]);
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(cleanup.cleanupIncomplete).toBe(false);
    } finally {
      denied = false;
      await runner.close();
    }
  },
);
