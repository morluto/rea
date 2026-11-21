import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { RuntimeControlUnavailableError } from "../domain/runtimeControlUnavailableError.js";
import type { WindowsNativeAuthority } from "./WindowsNativeLoader.js";
import {
  quoteWindowsProcessArgument,
  WindowsNativeControlUnavailableError,
  WindowsNativeSpawnControlError,
  WindowsOwnedProcess,
} from "./WindowsOwnedProcess.js";

describe("Windows process argument representation", () => {
  it.each([
    ["", '""'],
    ["plain", '"plain"'],
    ["two words", '"two words"'],
    ['embedded"quote', '"embedded\\"quote"'],
    ["D:\\folder\\", '"D:\\folder\\\\"'],
    ['slash\\"quote', '"slash\\\\\\"quote"'],
  ])("quotes %j without changing its CRT argument", (input, expected) => {
    expect(quoteWindowsProcessArgument(input)).toBe(expected);
  });

  it("rejects NUL before crossing the native boundary", () => {
    expect(() => quoteWindowsProcessArgument("a\0b")).toThrow("NUL");
  });
});

const LIMIT = 704 * 1024 * 1024;
const settledPoll = {
  stdout: Buffer.alloc(0),
  stderr: Buffer.from("allocation failed"),
  stdoutEnded: true,
  stderrEnded: true,
  exitCode: 3,
  activeProcesses: 0,
};

const idlePoll = {
  ...settledPoll,
  stderr: Buffer.alloc(0),
  stdoutEnded: false,
  stderrEnded: false,
  exitCode: null,
  activeProcesses: 1,
};

/** Native authority double that records calls and replays exact poll observations. */
const authority = (
  options: {
    readonly jobMemoryLimit?: true;
    readonly polls?: readonly unknown[];
    readonly appliedLimit?: (requested: unknown) => unknown;
    readonly failClose?: () => boolean;
    /** Native write result, awaited by the process before it releases the job. */
    readonly stdinWrite?: (bytes: Buffer) => unknown;
  } = {},
) => {
  const calls: { operation: string; arguments_: readonly unknown[] }[] = [];
  const polls = [...(options.polls ?? [])];
  const native: WindowsNativeAuthority = {
    inspection: {
      abiVersion: 1,
      nodeApiVersion: 8,
      architecture: "x64",
      filesystem: {
        requestedPath: "C:\\probe",
        finalPath: "C:\\probe",
        filesystem: "NTFS",
        volumeSerial: "0".repeat(16),
        fileId: "0".repeat(32),
        size: 0,
        directory: true,
      },
      privateDacl: true,
      privateBridgeDescriptorAccess: true,
      atomicJobAssignment: true,
      killOnOwnerClose: true,
      protocolStdin: true,
      ...(options.jobMemoryLimit === undefined ? {} : { jobMemoryLimit: true }),
    },
    call: (operation, arguments_) => {
      calls.push({ operation, arguments_ });
      if (operation === "process_spawn")
        return {
          pid: 42,
          handle: {},
          jobAssigned: true,
          killOnOwnerClose: true,
          ...(arguments_.length === 6
            ? {
                jobMemoryLimitBytes: (
                  options.appliedLimit ?? ((value) => value)
                )(arguments_[5]),
              }
            : {}),
        };
      if (operation === "process_poll") return polls.shift();
      if (operation === "process_stdin_write") {
        const bytes = arguments_[1] as Buffer;
        return options.stdinWrite?.(bytes) ?? bytes.length;
      }
      if (operation === "process_stdin_close") return null;
      if (operation === "process_terminate") return true;
      if (operation === "process_close") {
        if (options.failClose?.()) throw new Error("native close failed");
        return null;
      }
      throw new Error(`Unmodeled native operation ${operation}`);
    },
  };
  return { native, calls };
};

/** Launch a process that owns the writable protocol stdin pipe. */
const launchWithInput = (native: WindowsNativeAuthority): WindowsOwnedProcess =>
  new WindowsOwnedProcess(
    "C:\\runtime\\bun.exe",
    ["worker.js"],
    "C:\\work",
    {},
    false,
    { authority: native, protocolStdin: true },
  );

const launch = (
  native: WindowsNativeAuthority,
  memoryLimitBytes?: number,
): WindowsOwnedProcess =>
  new WindowsOwnedProcess(
    "C:\\runtime\\bun.exe",
    ["worker.js"],
    "C:\\work",
    {},
    false,
    {
      authority: native,
      ...(memoryLimitBytes === undefined ? {} : { memoryLimitBytes }),
    },
  );

describe("Windows native release retry", () => {
  it("ends output streams and retains ownership for a failed close retry", async () => {
    vi.useFakeTimers();
    let shouldFailClose = true;
    try {
      const { native, calls } = authority({
        polls: [settledPoll],
        failClose: () => shouldFailClose,
      });
      const child = launch(native);
      const failures: string[] = [];
      child.on("error", (error: Error) => failures.push(error.message));
      const closed = vi.fn();
      child.once("close", closed);

      await vi.advanceTimersByTimeAsync(25);
      expect(child.stdout.writableEnded).toBe(true);
      expect(child.stderr.writableEnded).toBe(true);
      expect(failures).toEqual(["native close failed"]);
      expect(closed).not.toHaveBeenCalled();
      expect(calls.some(({ operation }) => operation === "process_close")).toBe(
        true,
      );

      shouldFailClose = false;
      const callsBeforeRetry = calls.length;
      const cleanup = child.cleanup();
      expect(await cleanup).toMatchObject({ cleaned: true, signaled: false });
      expect(closed).toHaveBeenCalledExactlyOnceWith(3, null);
      expect(
        calls.slice(callsBeforeRetry).map(({ operation }) => operation),
      ).toEqual(["process_close"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

it.each([
  ["launcher exit", { exitCode: null }],
  ["stdout EOF", { stdoutEnded: false }],
  ["stderr EOF", { stderrEnded: false }],
  ["descendant exit", { activeProcesses: 1 }],
] as const)("keeps the Job Object open until %s", async (_event, pending) => {
  vi.useFakeTimers();
  try {
    const first = { ...settledPoll, stderr: Buffer.alloc(0), ...pending };
    const { native, calls } = authority({ polls: [first, settledPoll] });
    const child = launch(native);
    const events: string[] = [];
    child.on("exit", () => events.push("exit"));
    child.on("close", () => events.push("close"));

    await vi.advanceTimersByTimeAsync(25);
    expect(events).toEqual(first.exitCode === null ? [] : ["exit"]);
    expect(calls.map(({ operation }) => operation)).toEqual([
      "process_spawn",
      "process_poll",
    ]);

    await vi.advanceTimersByTimeAsync(25);
    expect(events).toEqual(["exit", "close"]);
    expect(calls.at(-1)?.operation).toBe("process_close");
  } finally {
    vi.useRealTimers();
  }
});

describe("Windows Job Object memory limits", () => {
  it("refuses a requested limit before launch when the artifact lacks the control", () => {
    const { native, calls } = authority();
    expect(() => launch(native, LIMIT)).toThrow(
      expect.objectContaining({
        constructor: WindowsNativeControlUnavailableError,
        control: "job-memory-limit",
        retryable: false,
        message: expect.stringContaining(
          "does not support Job Object memory limits",
        ),
      }),
    );
    expect(calls).toEqual([]);
  });

  it("refuses protocol stdin before launch when the artifact lacks the control", () => {
    const { native, calls } = authority();
    const earlier = {
      ...native,
      inspection: { ...native.inspection, protocolStdin: false },
    };
    expect(
      () =>
        new WindowsOwnedProcess(
          "C:\\runtime\\bun.exe",
          [],
          undefined,
          {},
          false,
          {
            authority: earlier,
            protocolStdin: true,
          },
        ),
    ).toThrow(
      expect.objectContaining({
        constructor: WindowsNativeControlUnavailableError,
        control: "protocol-stdin",
        message: expect.stringContaining(
          "does not support owned protocol stdin",
        ),
      }),
    );
    expect(calls).toEqual([]);
  });

  it("passes the limit, verifies its read-back and reports a reached limit before exit", async () => {
    const { native, calls } = authority({
      jobMemoryLimit: true,
      polls: [
        {
          ...settledPoll,
          exitCode: null,
          stdoutEnded: false,
          stderrEnded: false,
          activeProcesses: 1,
          memoryLimitReached: false,
          peakJobMemoryBytes: 300 * 1024 * 1024,
        },
        { ...settledPoll, memoryLimitReached: true, peakJobMemoryBytes: LIMIT },
      ],
    });
    const child = launch(native, LIMIT);
    expect(calls[0]?.arguments_.slice(4)).toEqual([false, LIMIT]);
    const closed = once(child, "close");
    const exited = new Promise((resolve) => {
      child.once("exit", (code: number) =>
        resolve({ code, reached: child.memoryLimitReached }),
      );
    });
    expect(await exited).toEqual({ code: 3, reached: true });
    expect(child.peakJobMemoryBytes).toBe(LIMIT);
    await closed;
    expect(calls.at(-1)?.operation).toBe("process_close");
  });

  it("refuses a launch whose applied limit differs from the request", () => {
    const { native } = authority({
      jobMemoryLimit: true,
      appliedLimit: () => LIMIT - 4096,
    });
    expect(() => launch(native, LIMIT)).toThrow(WindowsNativeSpawnControlError);
  });
});

describe("Windows process_spawn control vs executable classification", () => {
  it("wraps process_spawn host-control rejections as RuntimeControlUnavailableError while preserving executable launch failures", () => {
    const { native } = authority();
    const affinityFailure = Object.assign(
      new Error(
        "Caller CPU affinity cannot bound an owned process in another processor group [C:\\runtime\\bun.exe] (Win32 87): The parameter is incorrect.",
      ),
      {
        code: "ERR_REA_WINDOWS_NATIVE",
        constraint:
          "Caller CPU affinity cannot bound an owned process in another processor group",
        requestedPath: "C:\\runtime\\bun.exe",
        win32Code: 87,
      },
    );
    const affinityAuthority: WindowsNativeAuthority = {
      ...native,
      call: (operation) => {
        if (operation === "process_spawn") throw affinityFailure;
        throw new Error(`Unmodeled native operation ${operation}`);
      },
    };
    expect(() => launch(affinityAuthority)).toThrow(
      expect.objectContaining({
        constructor: WindowsNativeSpawnControlError,
        code: "windows-native-spawn-control-unavailable",
        constraint:
          "Caller CPU affinity cannot bound an owned process in another processor group",
        win32Code: 87,
        retryable: true,
        cause: affinityFailure,
      }),
    );

    const jobMembershipFailure = Object.assign(
      new Error(
        "Suspended process has no owned Job Object membership [C:\\runtime\\bun.exe] (Win32 5): Access is denied.",
      ),
      {
        code: "EACCES",
        constraint: "Suspended process has no owned Job Object membership",
        requestedPath: "C:\\runtime\\bun.exe",
        win32Code: 5,
      },
    );
    const jobMembershipAuthority: WindowsNativeAuthority = {
      ...native,
      call: (operation) => {
        if (operation === "process_spawn") throw jobMembershipFailure;
        throw new Error(`Unmodeled native operation ${operation}`);
      },
    };
    let caughtMembership: unknown;
    try {
      launch(jobMembershipAuthority);
    } catch (cause) {
      caughtMembership = cause;
    }
    expect(caughtMembership).toBeInstanceOf(RuntimeControlUnavailableError);
    expect(caughtMembership).toBeInstanceOf(WindowsNativeSpawnControlError);

    const executableFailure = Object.assign(
      new Error(
        "Create process atomically inside owned Job Object failed [C:\\runtime\\bun.exe] (Win32 2): The system cannot find the file specified.",
      ),
      {
        code: "ENOENT",
        constraint: "Create process atomically inside owned Job Object failed",
        requestedPath: "C:\\runtime\\bun.exe",
        win32Code: 2,
      },
    );
    const executableAuthority: WindowsNativeAuthority = {
      ...native,
      call: (operation) => {
        if (operation === "process_spawn") throw executableFailure;
        throw new Error(`Unmodeled native operation ${operation}`);
      },
    };
    let caughtExecutable: unknown;
    try {
      launch(executableAuthority);
    } catch (cause) {
      caughtExecutable = cause;
    }
    expect(caughtExecutable).toBe(executableFailure);
    expect(caughtExecutable).not.toBeInstanceOf(RuntimeControlUnavailableError);
  });
});

describe("Windows owned process input", () => {
  /** A native write that stays in flight until the test releases it. */
  const deferredWrite = () => {
    let deliver: ((written: number) => void) | undefined;
    const written = new Promise<number>((resolve) => {
      deliver = resolve;
    });
    return {
      written,
      deliver: (value: number) => deliver?.(value),
      stdinWrite: (bytes: Buffer) => written.then(() => bytes.length),
    };
  };

  it("reports a delivered write before an exited job releases the stream", async () => {
    vi.useFakeTimers();
    try {
      const write = deferredWrite();
      const { native, calls } = authority({
        polls: [{ ...settledPoll }],
        stdinWrite: write.stdinWrite,
      });
      const child = launchWithInput(native);
      const failures: string[] = [];
      child.stdin?.on("error", (error: Error) => failures.push(error.message));
      const delivered = new Promise<void>((resolve, reject) => {
        child.stdin?.write("body", (error) =>
          error === undefined || error === null ? resolve() : reject(error),
        );
      });

      // The job exits while the native write is still in flight.
      await vi.advanceTimersByTimeAsync(25);
      expect(calls.some(({ operation }) => operation === "process_close")).toBe(
        false,
      );

      // Cleanup must join the same delivery wait, not schedule a second poll
      // that tears down the streams before the write has reported.
      const cleanup = child.cleanup();
      await vi.advanceTimersByTimeAsync(25);
      expect(
        calls.filter(({ operation }) => operation === "process_poll"),
      ).toHaveLength(1);
      expect(child.stdin?.destroyed).toBe(false);

      write.deliver(4);
      await delivered;
      await vi.advanceTimersByTimeAsync(25);
      expect(await cleanup).toMatchObject({ cleaned: true });
      expect(failures).toEqual([]);
      expect(calls.some(({ operation }) => operation === "process_close")).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a deferred release failure instead of rejecting the host", async () => {
    vi.useFakeTimers();
    try {
      const write = deferredWrite();
      let shouldFailClose = true;
      const { native, calls } = authority({
        polls: [{ ...settledPoll }, { ...settledPoll }],
        failClose: () => shouldFailClose,
        stdinWrite: write.stdinWrite,
      });
      const child = launchWithInput(native);
      const failures: string[] = [];
      child.on("error", (error: Error) => failures.push(error.message));
      child.stdin?.on("error", () => undefined);
      const delivered = new Promise<void>((resolve) => {
        child.stdin?.write("body", () => resolve());
      });

      await vi.advanceTimersByTimeAsync(25);
      write.deliver(4);
      await delivered;
      await vi.advanceTimersByTimeAsync(25);

      // The native close failure is reported on the error channel and the
      // job stays owned for a cleanup retry.
      expect(failures).toContain("native close failed");
      expect(
        calls.filter(({ operation }) => operation === "process_close"),
      ).toHaveLength(1);
      const callsBeforeRetry = calls.length;
      expect(await child.cleanup()).toMatchObject({
        cleaned: false,
        reason: "native close failed",
      });
      expect(
        calls.slice(callsBeforeRetry).map(({ operation }) => operation),
      ).toEqual(["process_close"]);

      shouldFailClose = false;
      const callsBeforeRecovery = calls.length;
      expect(await child.cleanup()).toMatchObject({
        cleaned: true,
        signaled: false,
      });
      expect(
        calls.slice(callsBeforeRecovery).map(({ operation }) => operation),
      ).toEqual(["process_close"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a genuine write failure visible", async () => {
    vi.useFakeTimers();
    try {
      const { native } = authority({
        polls: [{ ...settledPoll }],
        stdinWrite: (bytes) => bytes.length - 1,
      });
      const child = launchWithInput(native);
      // A failed write also reaches the stream's error channel.
      child.stdin?.on("error", () => undefined);
      const failure = new Promise<Error>((resolve) => {
        child.stdin?.write("body", (error?: Error | null) =>
          resolve(error ?? new Error("write reported no error")),
        );
      });
      await vi.advanceTimersByTimeAsync(25);
      const error = await failure;
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain(
        "Owned Windows input write did not preserve all requested bytes",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

it("backs off when idle and drains sustained stdout and stderr without the idle delay", async () => {
  vi.useFakeTimers();
  try {
    const chunk = Buffer.alloc(8192, 0x61);
    const output = Array.from({ length: 10 }, (_, index) =>
      index % 2 === 0
        ? { ...idlePoll, stdout: chunk }
        : { ...idlePoll, stderr: chunk },
    );
    const { native, calls } = authority({
      polls: [idlePoll, ...output, settledPoll],
    });
    const child = launch(native);
    child.stdout.resume();
    child.stderr.resume();
    const closed = vi.fn();
    child.once("close", closed);
    const polls = () =>
      calls.filter(({ operation }) => operation === "process_poll").length;

    await vi.advanceTimersByTimeAsync(49);
    expect(polls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls()).toBe(2);
    // Each active poll needs the next tick, including stderr-only polls.
    await vi.advanceTimersByTimeAsync(10);
    expect(polls()).toBe(12);
    expect(closed).toHaveBeenCalledExactlyOnceWith(3, null);
  } finally {
    vi.useRealTimers();
  }
});

describe("Windows output backpressure and cleanup", () => {
  it("stops native reads until both paused output consumers drain", async () => {
    vi.useFakeTimers();
    try {
      const chunk = Buffer.alloc(65536, 0x63);
      const { native, calls } = authority({
        polls: [
          {
            stdout: chunk,
            stderr: chunk,
            stdoutEnded: false,
            stderrEnded: false,
            exitCode: null,
            activeProcesses: 1,
          },
          { ...settledPoll, stderr: Buffer.alloc(0) },
        ],
      });
      const child = launch(native);
      const closed = once(child, "close");
      child.stdout.pause();
      child.stderr.pause();
      const pollCount = () =>
        calls.filter((call) => call.operation === "process_poll").length;
      await vi.advanceTimersByTimeAsync(25);
      expect(child.stdout.writableNeedDrain).toBe(true);
      expect(child.stderr.writableNeedDrain).toBe(true);
      await vi.advanceTimersByTimeAsync(5000);
      expect(pollCount()).toBe(1);
      const stdoutDrained = once(child.stdout, "drain");
      child.stdout.resume();
      await stdoutDrained;
      await vi.advanceTimersByTimeAsync(25);
      expect(pollCount()).toBe(1);
      const stderrDrained = once(child.stderr, "drain");
      child.stderr.resume();
      await stderrDrained;
      await vi.advanceTimersByTimeAsync(1);
      await closed;
      expect(pollCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards blocked output during cleanup so the owned job can settle", async () => {
    vi.useFakeTimers();
    try {
      const chunk = Buffer.alloc(65536, 0x64);
      const { native, calls } = authority({
        polls: [
          {
            stdout: chunk,
            stderr: Buffer.alloc(0),
            stdoutEnded: false,
            stderrEnded: false,
            exitCode: null,
            activeProcesses: 1,
          },
          { ...settledPoll, stderr: Buffer.alloc(0) },
        ],
      });
      const child = launch(native);
      child.stdout.pause();
      await vi.advanceTimersByTimeAsync(25);
      expect(child.stdout.writableNeedDrain).toBe(true);
      const closed = once(child, "close");
      const cleanup = child.cleanup();
      await vi.advanceTimersByTimeAsync(25);
      expect(await cleanup).toEqual({ cleaned: true, signaled: true });
      await closed;
      expect(
        calls.filter((call) => call.operation === "process_poll"),
      ).toHaveLength(2);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.outputIncomplete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes polling when a blocked output stream is destroyed", async () => {
    vi.useFakeTimers();
    try {
      const chunk = Buffer.alloc(65536, 0x65);
      const { native, calls } = authority({
        polls: [
          {
            stdout: chunk,
            stderr: Buffer.alloc(0),
            stdoutEnded: false,
            stderrEnded: false,
            exitCode: null,
            activeProcesses: 1,
          },
          { ...settledPoll, stderr: Buffer.alloc(0) },
        ],
      });
      const child = launch(native);
      const closed = once(child, "close");
      await vi.advanceTimersByTimeAsync(25);
      expect(child.stdout.writableNeedDrain).toBe(true);
      child.stdout.destroy();
      await vi.advanceTimersByTimeAsync(0);
      await closed;
      expect(
        calls.filter((call) => call.operation === "process_poll"),
      ).toHaveLength(2);
      expect(child.outputIncomplete).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Windows output poll failure", () => {
  it("keeps polling after failed native polls and reports the run once", async () => {
    vi.useFakeTimers();
    try {
      const { native, calls } = authority({
        polls: [
          { malformed: true },
          { malformed: true },
          {
            stdout: Buffer.from("frame\n"),
            stderr: Buffer.alloc(0),
            stdoutEnded: false,
            stderrEnded: false,
            exitCode: null,
            activeProcesses: 1,
          },
          { ...settledPoll, stderr: Buffer.alloc(0), exitCode: 0 },
        ],
      });
      const child = launch(native);
      const errors: unknown[] = [];
      child.on("error", (error) => errors.push(error));
      const output: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      let closed = false;
      child.once("close", () => (closed = true));
      const polls = () =>
        calls.filter((call) => call.operation === "process_poll").length;
      // Failed polls back off 250 ms instead of retrying at the idle cadence.
      await vi.advanceTimersByTimeAsync(25);
      expect(polls()).toBe(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(polls()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(polls()).toBe(2);
      await vi.advanceTimersByTimeAsync(249);
      expect(polls()).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(polls()).toBe(3);
      // Output resumes the immediate cadence (Node clamps a 0 ms timer to 1 ms).
      await vi.advanceTimersByTimeAsync(1);
      expect(polls()).toBe(4);
      expect(errors).toHaveLength(1);
      expect(Buffer.concat(output).toString()).toBe("frame\n");
      expect(child.exitCode).toBe(0);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

const limitedPoll = {
  ...settledPoll,
  memoryLimitReached: true,
  peakJobMemoryBytes: LIMIT,
};

it.each([
  {
    job: "unlimited",
    limit: undefined,
    invalid: limitedPoll,
    valid: settledPoll,
    launchArguments: 4,
  },
  {
    job: "limited",
    limit: LIMIT,
    invalid: settledPoll,
    valid: limitedPoll,
    launchArguments: 6,
  },
])(
  "rejects an incompatible $job job poll and accepts the next valid observation",
  async ({ limit, invalid, valid, launchArguments }) => {
    vi.useFakeTimers();
    try {
      const { native, calls } = authority({
        jobMemoryLimit: true,
        polls: [invalid, valid],
      });
      const child = launch(native, limit);
      const errors = vi.fn();
      const closed = vi.fn();
      child.on("error", errors);
      child.on("close", closed);

      await vi.advanceTimersByTimeAsync(25);
      expect(calls[0]?.arguments_).toHaveLength(launchArguments);
      expect(errors).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
      expect(child.exitCode).toBeNull();
      expect(child.memoryLimitReached).toBe(false);
      expect(child.peakJobMemoryBytes).toBeUndefined();
      expect(closed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(250);
      expect(child.memoryLimitReached).toBe(limit !== undefined);
      expect(child.peakJobMemoryBytes).toBe(limit);
      expect(closed).toHaveBeenCalledExactlyOnceWith(3, null);
      expect(
        calls.filter(({ operation }) => operation === "process_close"),
      ).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  },
);
