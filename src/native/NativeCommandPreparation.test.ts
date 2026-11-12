import { afterEach, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { failedInspectionDescriptor } from "../../tests/fixtures/processInspectionCleanup.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { nativeMachoTargetForFile } from "../../tests/fixtures/nativeCommands.js";
import { fat } from "../domain/binaryTarget.fixture.js";
import { primaryAnalysisError } from "../domain/analysisErrorBase.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import {
  ProcessOwnershipIdentityBatchFailure,
  ProcessOwnershipInspectionCancelled,
} from "../process/ProcessInspectionCancellation.js";
import { NativeMacOSProvider } from "./NativeMacOSProvider.js";
import { XcrunCommandRunner, NativeCommandFailure } from "./CommandRunner.js";
import { LldbCallTracer } from "./LldbCallTracer.js";
import { NativeFixtureRunner } from "../../tests/fixtures/nativeCommands.js";
import { err } from "../domain/result.js";

vi.mock("../process/OwnedCommand.js", async (original) => ({
  ...(await original<typeof import("../process/OwnedCommand.js")>()),
  runOwnedCommand: vi.fn(),
}));
afterEach(() => vi.mocked(runOwnedCommand).mockReset());

it.each([false, true])(
  "retries native inspection descriptor cleanup (batch: %s)",
  async (batch) => {
    const file = await failedInspectionDescriptor();
    const reason = new Error("recorded batch cancellation");
    const preparation = batch
      ? new ProcessOwnershipIdentityBatchFailure(
          [
            { pid: 41, requestIndex: 0, cause: file.failure },
            {
              pid: 42,
              requestIndex: 1,
              cause: new ProcessOwnershipInspectionCancelled(reason),
            },
          ],
          new Map(),
        )
      : file.failure;
    vi.mocked(runOwnedCommand).mockRejectedValue(preparation);
    const root = await createTestTempDirectory("rea-native-inspection-");
    const path = join(root, "app");
    await writeFile(path, fat([0x01000007]));
    const client = new NativeMacOSProvider(
      {},
      new XcrunCommandRunner({}),
      "darwin",
    ).createClient(await nativeMachoTargetForFile(path));
    const result = await client.execute("list_architectures", {});
    if (result.ok) throw new Error("Expected inspection failure");
    const primary = primaryAnalysisError(result.error);
    expect(primary).toBeInstanceOf(ProviderAdapterError);
    expect(result.error.cleanupResources).toContain(file.path);
    expect(primary.secondaryFailures.map((failure) => failure.cause)).toEqual(
      batch ? [reason] : [],
    );
    expect((await client.close()).ok).toBe(false);
    expect(file.handle.fd).not.toBe(-1);
    file.allow();
    expect((await client.close()).ok).toBe(true);
    expect(file.handle.fd).toBe(-1);
    expect(result.error.cleanupIncomplete).toBe(false);
  },
);

it("preserves the native inspection cancellation owner's opaque reason", async () => {
  const reason = { selected: "caller reason" };
  const preparation = new ProcessOwnershipInspectionCancelled(reason);
  vi.mocked(runOwnedCommand).mockRejectedValue(
    new OwnedCommandFailure("cancelled", "preparation cancelled", null, null, {
      preparationFailure: preparation,
      cancellation: { reason },
    }),
  );
  const runner = new XcrunCommandRunner({});
  const root = await createTestTempDirectory(
    "rea-native-cancelled-inspection-",
  );
  const path = join(root, "app");
  await writeFile(path, fat([0x01000007]));
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    await nativeMachoTargetForFile(path),
  );
  const result = await client.execute("list_architectures", {});
  if (result.ok) throw new Error("Expected inspection cancellation");
  expect(primaryAnalysisError(result.error)._tag).toBe(
    "AnalysisCancelledError",
  );
  expect(primaryAnalysisError(result.error).cause).toBe(reason);
  expect((await client.close()).ok).toBe(true);
});

it("retries LLDB discovery descriptor cleanup and resolves earlier close failures", async () => {
  const file = await failedInspectionDescriptor();
  const launch = vi.fn(async () => {
    throw new Error("LLDB cannot launch after resolver refusal");
  });
  const tracer = new LldbCallTracer({}, launch, async () =>
    err(new NativeCommandFailure("lldb", "io", null, { cause: file.failure })),
  );
  const root = await createTestTempDirectory("rea-lldb-inspection-");
  const path = join(root, "app");
  await writeFile(path, fat([0x0100000c]));
  const client = new NativeMacOSProvider(
    {},
    new NativeFixtureRunner(),
    "darwin",
    () => tracer,
  ).createClient(await nativeMachoTargetForFile(path));
  const result = await client.execute("observe_native_calls", {
    breakpoints: [{ kind: "function", name: "main" }],
  });
  if (result.ok) throw new Error("Expected discovery failure");
  expect(result.error.cleanupResources).toContain(file.path);
  const closed = await client.close();
  if (closed.ok) throw new Error("Expected discovery cleanup refusal");
  expect(closed.error.cleanupIncomplete).toBe(true);
  expect(file.handle.fd).not.toBe(-1);
  file.allow();
  expect((await client.close()).ok).toBe(true);
  expect(file.handle.fd).toBe(-1);
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(closed.error.cleanupIncomplete).toBe(false);
  expect(launch).not.toHaveBeenCalled();
});
