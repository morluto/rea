import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { afterEach, expect, it, vi } from "vitest";
import { phaseArrival } from "../../../support/lifecycleHarness.js";

import {
  resolveXcrunTool,
  XcrunCommandRunner,
  type NativeCommandLauncher,
} from "../../../../src/providers/NativeCommandRunner.js";

const realpathState = vi.hoisted(() => ({
  resolve: undefined as ((path: string) => Promise<string>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: (path: string): Promise<string> => {
      if (realpathState.resolve === undefined)
        throw new Error("realpath fixture was not configured");
      return realpathState.resolve(path);
    },
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});

const launchWithOutput = async (
  options: Parameters<NativeCommandLauncher>[0],
  stdout: string,
): ReturnType<NativeCommandLauncher> => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: () => true,
  });
  setImmediate(() => {
    child.stdout.end(stdout);
    child.stderr.end();
    child.exitCode = 0;
    child.emit("exit", 0, null);
    child.emit("close", 0, null);
  });
  return {
    process: child,
    ownership: {
      runId: options.runId,
      leaderPid: 48_100,
      processGroupId: 48_100,
      expectedParentPid: process.pid,
    },
    cleanup: async () => ({ cleaned: true, signaled: false }),
  };
};

const launcher: NativeCommandLauncher = (options) =>
  launchWithOutput(options, "/controlled/native-tool\n");

afterEach(() => {
  realpathState.resolve = undefined;
});

it("keeps a realpath I/O failure primary when cancellation is observed before rejection", async () => {
  const realpathStart = phaseArrival();
  let rejectRealpath: ((cause: unknown) => void) | undefined;
  realpathState.resolve = () =>
    new Promise<string>((_resolve, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason);
        return;
      }
      rejectRealpath = reject;
      realpathStart.arrive();
    });
  const controller = new AbortController();
  const cancellationReason = { source: "caller", phase: "tool resolution" };
  const pending = resolveXcrunTool("file", {}, controller.signal, launcher);
  try {
    await realpathStart.reached(pending, "native tool realpath");
    controller.abort(cancellationReason);
    const ioFailure = Object.assign(new Error("fixture realpath failure"), {
      code: "EACCES",
    });
    rejectRealpath?.(ioFailure);

    const result = await pending;
    if (result.ok) throw new Error("Expected realpath I/O failure");
    expect(result.error).toMatchObject({
      reason: "io",
      cancellation: { reason: cancellationReason },
    });
    expect(result.error.cancellation?.reason).toBe(cancellationReason);
    expect(result.error.cause).toBe(ioFailure);
  } finally {
    controller.abort(cancellationReason);
    rejectRealpath?.(new Error("fixture cleanup"));
    await pending;
  }
});

it("retains exact cancellation observed after successful tool path resolution", async () => {
  let finishRealpath: (() => void) | undefined;
  const realpathStart = phaseArrival();
  realpathState.resolve = () =>
    new Promise<string>((resolve, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason);
        return;
      }
      finishRealpath = () => resolve("/controlled/physical-tool");
      realpathStart.arrive();
    });
  const controller = new AbortController();
  const cancellationReason = { source: "caller", phase: "tool selection" };
  const pending = resolveXcrunTool("file", {}, controller.signal, launcher);
  try {
    await realpathStart.reached(pending, "native tool realpath");
    controller.abort(cancellationReason);
    finishRealpath?.();

    const result = await pending;
    if (result.ok) throw new Error("Expected selection cancellation");
    expect(result.error).toMatchObject({
      reason: "cancelled",
      cancellation: { reason: cancellationReason },
    });
    expect(result.error.cancellation?.reason).toBe(cancellationReason);
    expect(result.error.cause).toMatchObject({
      reason: "cancelled",
      cause: cancellationReason,
    });
  } finally {
    controller.abort(cancellationReason);
    finishRealpath?.();
    await pending;
  }
});

it.skipIf(process.platform === "win32")(
  "uses the AbortError cause as the exact tool-hash cancellation fact",
  async () => {
    let finishRealpath: (() => void) | undefined;
    const realpathStart = phaseArrival();
    realpathState.resolve = () =>
      new Promise<string>((resolve, reject) => {
        if (controller.signal.aborted) {
          reject(controller.signal.reason);
          return;
        }
        finishRealpath = () => resolve("/dev/zero");
        realpathStart.arrive();
      });
    const controller = new AbortController();
    const cancellationReason = { source: "caller", phase: "tool hash" };
    const pending = resolveXcrunTool("file", {}, controller.signal, launcher);
    try {
      await realpathStart.reached(pending, "native tool hash selection");
      finishRealpath?.();
      setImmediate(() => controller.abort(cancellationReason));

      const result = await pending;
      if (result.ok) throw new Error("Expected hash cancellation");
      expect(result.error).toMatchObject({
        reason: "cancelled",
        cancellation: { reason: cancellationReason },
      });
      expect(result.error.cause).toMatchObject({
        name: "AbortError",
        code: "ABORT_ERR",
        cause: cancellationReason,
      });
      expect(result.error.cancellation?.reason).toBe(cancellationReason);
      expect(result.error.cause).toBeInstanceOf(Error);
      expect((result.error.cause as Error).cause).toBe(cancellationReason);
    } finally {
      controller.abort(cancellationReason);
      finishRealpath?.();
      await pending;
    }
  },
);

it.skipIf(process.platform === "win32")(
  "resolves xcrun on every call and reuses only the freshly selected file digest",
  async () => {
    const actual =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    realpathState.resolve = actual.realpath;
    const directory = await createTestTempDirectory("rea-xcrun-digest-");
    const toolA = join(directory, "xcode-a-file");
    const toolB = join(directory, "xcode-b-file");
    const link = join(directory, "selected-file");
    await writeFile(toolA, "A");
    await writeFile(toolB, "B");
    await symlink(toolA, link);
    let selection = link;
    const resolutions = vi.fn();
    const invocations = vi.fn();
    const runner = new XcrunCommandRunner({}, undefined, (options) => {
      if (options.command === "/usr/bin/xcrun") {
        resolutions(options.arguments);
        return launchWithOutput(options, selection + "\n");
      }
      invocations(options.command);
      return launchWithOutput(options, "tool output\n");
    });
    const reads = vi.mocked(createReadStream);
    reads.mockClear();
    const check = async (content: string) => {
      const result = await runner.run("file", [], {});
      if (!result.ok) throw result.error;
      expect(result.value).toMatchObject({
        executable: selection,
        executableSha256: createHash("sha256").update(content).digest("hex"),
      });
    };

    await check("A");
    await check("A");
    expect(reads).toHaveBeenCalledTimes(1);
    await unlink(link);
    await symlink(toolB, link);
    await check("B");
    await writeFile(toolB, "replacement");
    await check("replacement");
    await unlink(toolB);
    expect(await runner.run("file", [], {})).toMatchObject({
      ok: false,
      error: { reason: "io" },
    });
    selection = toolA;
    await check("A");
    expect(reads).toHaveBeenCalledTimes(4);
    expect(resolutions.mock.calls).toEqual(Array(6).fill([["--find", "file"]]));
    expect(invocations.mock.calls.map(([path]) => path)).toEqual([
      link,
      link,
      link,
      link,
      toolA,
    ]);
  },
);
