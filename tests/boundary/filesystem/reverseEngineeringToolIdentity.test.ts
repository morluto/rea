import { createHash } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { delimiter, dirname } from "node:path";

import { expect, expectTypeOf, it, vi } from "vitest";

import {
  digestFile,
  type ReverseEngineeringProcesses,
  VERSION_PROBE_FAILURE_REASONS,
} from "../../../src/application/reverse/ReverseEngineeringService.js";
import { lookupExecutable } from "../../../src/process/ExecutableLookup.js";
import { RIZIN_VERSION_PROBE } from "../../../src/rizin/RizinCommand.js";
import { OwnedCommandFailure } from "../../../src/process/OwnedCommand.js";
import type { ProviderProcessSupervisor } from "../../../src/process/ProviderProcess.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";
import {
  type ExecFileOutputOptions,
  rizinExecutableFixture,
  versionProbeCount,
  versionProbeRunner,
} from "../../support/rizinToolIdentity.js";
import { providerSnapshot } from "../../support/reverseEngineeringCompositionFixtures.js";
import { TestReverseEngineeringService } from "../../support/reverseEngineeringService.js";
import { createReverseEngineeringCommandPort } from "../../../src/composition/reverseEngineering.js";

/** Wait for launched work, failing instead of hanging past a bounded deadline. */
const within = async <Value>(
  operation: Promise<Value>,
  boundary: string,
): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${boundary} did not settle in time`)),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** A gate that a test releases, registered before the work that waits on it. */
const gate = () => {
  let open: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open: () => open?.() };
};

// The selected executable is a POSIX mode-0755 file; Windows resolves
// REA_RIZIN_COMMAND separately and is not covered here.
const posix = it.skipIf(process.platform === "win32");

posix(
  "records the version from the banner and probes the path it hashed before every command",
  async () => {
    const { executable, path, digest } = await rizinExecutableFixture();
    // Homebrew's Rizin 0.9.1 printed this banner, package suffix included.
    const banner = "rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)";
    const run = versionProbeRunner(() => `${banner}\ncommit: abc`);
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: "rizin", PATH: dirname(executable) },
    });
    for (const command of ["iI", "iS"]) {
      const result = await service.executeRizinCommand({
        path,
        command,
        command_timeout_ms: 4_321,
      });
      if (!result.ok) throw result.error;
      expect(result.value.provider).toEqual({
        id: "rizin",
        name: "Rizin",
        version: "0.9.1",
      });
      expect(result.value.parameters).toMatchObject({
        provider_executable: "rizin",
        provider_executable_path: executable,
        provider_executable_sha256: await digest(),
        provider_version_banner: banner,
        provider_version_banner_truncated: false,
        provider_identity: "banner",
      });
    }
    // Each call probes, then runs its command, both from the resolved path
    // and within the call's budget.
    expect(
      run.mock.calls.map(([command, args, options]) => [
        command,
        args[0] === "-v" ? "-v" : args.at(-2),
        options?.timeout,
      ]),
    ).toEqual([
      [executable, "-v", 4_321],
      [executable, "iI", 4_321],
      [executable, "-v", 4_321],
      [executable, "iS", 4_321],
    ]);

    await writeFile(executable, "#!/bin/sh\nexit 1\n");
    const changed = await service.executeRizinCommand({ path, command: "iI" });
    if (!changed.ok) throw changed.error;
    expect(changed.value.parameters.provider_executable_sha256).toBe(
      await digest(),
    );
    expect(versionProbeCount(run)).toBe(3);
  },
);

posix(
  "gives a fake runner's results to its commands when an executable rizin is first on PATH",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    const results = ["first result", "second result"];
    const run = vi.fn(
      async (
        _command: string,
        _args: readonly string[],
        _options?: ExecFileOutputOptions,
      ) => ({ stdout: results.shift() ?? "unexpected call", stderr: "" }),
    );
    // As on a developer machine with Rizin installed; no lookup is injected.
    const service = new TestReverseEngineeringService({
      run,
      environment: {
        PATH: `${dirname(executable)}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    for (const [command, stdout] of [
      ["iI", "first result"],
      ["iS", "second result"],
    ] as const) {
      const result = await service.executeRizinCommand({ path, command });
      if (!result.ok) throw result.error;
      expect(result.value.raw_result).toMatchObject({ stdout });
      expect(result.value.parameters).not.toHaveProperty(
        "provider_executable_path",
      );
    }
    expect(
      run.mock.calls.map(([command, args]) => [command, args.at(-2)]),
    ).toEqual([
      ["rizin", "iI"],
      ["rizin", "iS"],
    ]);
    // The service accepts a runner only together with its lookup.
    expectTypeOf<{
      readonly run: typeof run;
    }>().not.toExtend<ReverseEngineeringProcesses>();
  },
);

posix.each([
  [
    // radare2 6.1.8's real first line; later lines are not read.
    "radare2 6.1.8 +0 abi:110 @ darwin-arm_64\nbirth: git.6.1.8 2026-06-23__11:48:36\ncommit: 6.1.8",
    "radare2 6.1.8 +0 abi:110 @ darwin-arm_64",
    { id: "rizin", name: "radare2", version: "6.1.8" },
    "banner",
    "not Rizin",
  ],
  [
    // Rizin 0.9.1's real banner from Homebrew.
    "rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)",
    "rizin 0.9.1 @ darwin-arm-64, package: 0.9.1_2 (Homebrew)",
    { id: "rizin", name: "Rizin", version: "0.9.1" },
    "banner",
    "comes from its -v banner",
  ],
  [
    "Warning: 123 plugins could not be loaded",
    "Warning: 123 plugins could not be loaded",
    { id: "rizin", name: "Rizin", version: null },
    "assumed",
    RIZIN_VERSION_PROBE.assumedIdentity,
  ],
  [
    "Processing 3 plugins\nrizin 0.9.1 @ linux-x86-64",
    "Processing 3 plugins",
    { id: "rizin", name: "Rizin", version: null },
    "assumed",
    RIZIN_VERSION_PROBE.assumedIdentity,
  ],
  [
    "rizin 0.9.1",
    "rizin 0.9.1",
    { id: "rizin", name: "Rizin", version: null },
    "assumed",
    RIZIN_VERSION_PROBE.assumedIdentity,
  ],
  [
    "Usage: tool [options]",
    "Usage: tool [options]",
    { id: "rizin", name: "Rizin", version: null },
    "assumed",
    RIZIN_VERSION_PROBE.assumedIdentity,
  ],
  [
    "\nrizin 0.9.1 @ linux-x86-64",
    "",
    { id: "rizin", name: "Rizin", version: null },
    "assumed",
    RIZIN_VERSION_PROBE.assumedIdentity,
  ],
])(
  "runs the command for -v output %j and records what it identified",
  async (stdout, banner, provider, identity, limitation) => {
    const { executable, path } = await rizinExecutableFixture();
    const run = versionProbeRunner(() => stdout);
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (!result.ok) throw result.error;
    expect(result.value.provider).toEqual(provider);
    expect(result.value.parameters).toMatchObject({
      provider_version_banner: banner,
      provider_identity: identity,
    });
    expect(result.value.limitations).toEqual(
      expect.arrayContaining([expect.stringContaining(limitation)]),
    );
    expect(result.value.raw_result).toMatchObject({
      stdout: "command output",
    });
  },
);

posix(
  "keeps a failed probe's exit and output and still runs the command",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    const run = vi.fn(
      async (
        _command: string,
        args: readonly string[],
        _options?: ExecFileOutputOptions,
      ) => {
        if (args[0] === "-v")
          throw Object.assign(new Error("probe exited"), {
            code: 2,
            signal: null,
            stdout: "usage: tool [options]\n",
            stderr: "unknown option -v\n",
          });
        return { stdout: "command output", stderr: "" };
      },
    );
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    for (const command of ["iI", "iS"]) {
      const result = await service.executeRizinCommand({ path, command });
      if (!result.ok) throw result.error;
      expect(result.value.provider).toEqual({
        id: "rizin",
        name: "Rizin",
        version: null,
      });
      expect(result.value.parameters).toMatchObject({
        provider_executable_path: executable,
        provider_version_probe: {
          exit_code: 2,
          signal: null,
          stdout: "usage: tool [options]\n",
          stderr: "unknown option -v\n",
          output_truncated: false,
        },
      });
      expect(result.value.parameters).not.toHaveProperty(
        "provider_version_banner",
      );
      expect(result.value.raw_result).toMatchObject({
        stdout: "command output",
      });
    }
    expect(versionProbeCount(run)).toBe(2);
  },
);

posix(
  "runs each caller's probe under its own deadline and cancellation",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    const firstStarted = gate();
    const secondStarted = gate();
    const release = gate();
    const run = vi.fn(
      async (
        _command: string,
        args: readonly string[],
        options?: ExecFileOutputOptions,
      ) => {
        if (args[0] !== "-v") return { stdout: "command output", stderr: "" };
        (versionProbeCount(run) === 1 ? firstStarted : secondStarted).open();
        const signal = options?.signal;
        const aborted = new Promise<"aborted">((resolve) => {
          if (signal?.aborted === true) resolve("aborted");
          signal?.addEventListener("abort", () => resolve("aborted"), {
            once: true,
          });
        });
        if ((await Promise.race([release.opened, aborted])) === "aborted")
          throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
        return { stdout: "rizin 0.9.1 @ linux-x86-64", stderr: "" };
      },
    );
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const leaving = new AbortController();
    const pending: Promise<unknown>[] = [];
    try {
      const first = service.executeRizinCommand(
        { path, command: "iI", command_timeout_ms: 1_234 },
        { signal: leaving.signal },
      );
      pending.push(first);
      await awaitAcknowledgement(firstStarted.opened, first, "first probe");
      const second = service.executeRizinCommand({
        path,
        command: "iS",
        command_timeout_ms: 5_678,
      });
      pending.push(second);
      await awaitAcknowledgement(secondStarted.opened, second, "second probe");
      leaving.abort("first caller left");
      const left = await within(first, "cancelled first call");
      if (left.ok) throw new Error("Expected the first caller to be cancelled");
      expect(left.error._tag).toBe("AnalysisCancelledError");
      expect(left.error.cause).toBe("first caller left");
      release.open();
      const answered = await within(second, "second call");
      if (!answered.ok) throw answered.error;
      expect(answered.value.provider.version).toBe("0.9.1");
      const probeCalls = run.mock.calls.filter(([, args]) => args[0] === "-v");
      expect(probeCalls.map(([, , options]) => options?.timeout)).toEqual([
        1_234, 5_678,
      ]);
      expect(probeCalls[0]?.[2]?.signal).not.toBe(probeCalls[1]?.[2]?.signal);
    } finally {
      release.open();
      leaving.abort("test cleanup");
      await Promise.allSettled(pending);
      await service.close();
    }
  },
);

posix(
  "reads the working directory only when the PATH search reaches a relative entry, and skips that entry when the read fails",
  async () => {
    const { executable } = await rizinExecutableFixture();
    const directory = dirname(executable);
    const workingDirectory = vi.fn((): string => {
      throw Object.assign(new Error("uv_cwd"), { code: "ENOENT" });
    });
    await expect(
      lookupExecutable("rizin", workingDirectory, `${directory}${delimiter}.`),
    ).resolves.toEqual({ status: "found", path: executable });
    expect(workingDirectory).not.toHaveBeenCalled();
    await expect(
      lookupExecutable("rizin", workingDirectory, `.${delimiter}${directory}`),
    ).resolves.toEqual({ status: "found", path: executable });
    expect(workingDirectory).toHaveBeenCalledOnce();
    // Without a later match, the unread entry leaves the command unknown.
    await expect(
      lookupExecutable("rizin", workingDirectory, "."),
    ).resolves.toMatchObject({ status: "no-working-directory" });
  },
);

posix.each(["cancellation", "deadline"] as const)(
  "stops a stalled executable lookup on its %s without running anything",
  async (interruption) => {
    const { executable, path } = await rizinExecutableFixture();
    const lookupStarted = gate();
    const release = gate();
    const run = versionProbeRunner(() => "rizin 0.9.1 @ linux-x86-64");
    const service = new TestReverseEngineeringService({
      run,
      // The lookup stalls on the executable, as on an unresponsive PATH mount.
      lookup: (command, directory, searchPath, bounds) =>
        lookupExecutable(command, directory, searchPath, {
          ...bounds,
          stat: async (target) => {
            if (target === executable) {
              lookupStarted.open();
              await release.opened;
            }
            return stat(target);
          },
        }),
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const caller = new AbortController();
    const pending: Promise<unknown>[] = [];
    try {
      const call = service.executeRizinCommand(
        {
          path,
          command: "iI",
          ...(interruption === "deadline" ? { command_timeout_ms: 50 } : {}),
        },
        { signal: caller.signal },
      );
      pending.push(call);
      await awaitAcknowledgement(
        lookupStarted.opened,
        call,
        "executable lookup",
      );
      if (interruption === "cancellation") caller.abort("stop the lookup");
      const result = await within(call, "interrupted call");
      if (result.ok) throw new Error("Expected the lookup to be interrupted");
      expect(result.error._tag).toBe(
        interruption === "cancellation"
          ? "AnalysisCancelledError"
          : "AnalysisTimeoutError",
      );
      if (interruption === "cancellation")
        expect(result.error.cause).toBe("stop the lookup");
      // The candidate it was checking names the location that stalled.
      expect(result.error.diagnostics).toEqual({
        phase: "executable_lookup",
        executable_lookup_candidate: executable,
      });
      expect(run).not.toHaveBeenCalled();
      // Closing does not wait for the abandoned file-system call.
      await within(service.close(), "service close");
    } finally {
      release.open();
      caller.abort("test cleanup");
      await Promise.allSettled(pending);
      await service.close();
    }
  },
);

posix(
  "returns the caller's cancellation from the probe without starting the command",
  async () => {
    const { executable, path, digest } = await rizinExecutableFixture();
    const caller = new AbortController();
    const reason = { caller: "stop during version probe" };
    const run = vi.fn(
      async (
        _command: string,
        args: readonly string[],
        _options?: ExecFileOutputOptions,
      ) => {
        expect(args).toEqual(["-v"]);
        caller.abort(reason);
        throw Object.assign(new Error("aborted"), { code: "ABORT_ERR" });
      },
    );
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand(
      { path, command: "iI" },
      { signal: caller.signal },
    );
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    expect(result.error.cause).toBe(reason);
    // The path and digest it probed survive the cancellation.
    expect(result.error.diagnostics).toMatchObject({
      phase: "version_probe",
      provider_executable_path: executable,
      provider_executable_sha256: await digest(),
    });
    expect(run).toHaveBeenCalledOnce();
  },
);

posix(
  "retains a probe whose cleanup is incomplete until its owner stops",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    let stopped = false;
    const owner = {
      stop: async () =>
        stopped
          ? { status: "stopped" as const }
          : { status: "incomplete" as const, reason: "probe still running" },
    } as unknown as ProviderProcessSupervisor;
    const runOwned = vi.fn(
      async (request: { readonly arguments: readonly string[] }) => {
        if (request.arguments[0] === "-v")
          throw new OwnedCommandFailure(
            "process",
            "probe cleanup failed",
            providerSnapshot({
              stdout: { text: "", bytes: 0, observedBytes: 0 },
            }),
            "probe still running",
            undefined,
            ["pid:9"],
            owner,
          );
        return providerSnapshot();
      },
    );
    const service = new TestReverseEngineeringService({
      runOwned,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const failed = await service.executeRizinCommand({ path, command: "iI" });
    expect(failed).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisOutputError",
        cleanup: { reason: "probe still running", resources: ["pid:9"] },
      },
    });
    expect(runOwned).toHaveBeenCalledOnce();

    const blocked = await service.executeRizinCommand({ path, command: "iI" });
    expect(blocked.ok).toBe(false);
    expect(runOwned).toHaveBeenCalledOnce();

    stopped = true;
    expect(await service.retryCleanup()).toEqual({ ok: true, value: null });
    expect(failed.ok ? undefined : failed.error.cleanupIncomplete).toBe(false);
  },
);

posix(
  "reports no exit status in a probe's captured output when that output was not fully collected",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    let stopped = false;
    const owner = {
      stop: async () =>
        stopped
          ? { status: "stopped" as const }
          : { status: "incomplete" as const, reason: "probe still running" },
    } as unknown as ProviderProcessSupervisor;
    const runOwned = vi.fn(
      async (request: { readonly arguments: readonly string[] }) => {
        if (request.arguments[0] !== "-v") return providerSnapshot();
        // The probe exits 0, but neither its output nor its cleanup completes.
        throw new OwnedCommandFailure(
          "process",
          "probe output and cleanup failed",
          providerSnapshot({
            stdout: { text: "", bytes: 0, observedBytes: 0 },
          }),
          "probe still running",
          { collectionFailure: true },
          ["pid:9"],
          owner,
        );
      },
    );
    const service = new TestReverseEngineeringService({
      runOwned,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (result.ok) throw new Error("Expected the probe's cleanup to end it");
    expect(result.error._tag).toBe("AnalysisOutputError");
    expect(result.error.capturedOutput).toMatchObject({ exit_code: null });
    stopped = true;
    expect(await service.retryCleanup()).toEqual({ ok: true, value: null });
  },
);

posix.each(["deadline", "cancellation"] as const)(
  "ends the call without running anything when hashing the executable meets its %s, keeping the path found",
  async (interruption) => {
    const { executable, path } = await rizinExecutableFixture();
    const digestStarted = gate();
    const release = gate();
    const run = versionProbeRunner(() => "rizin 0.9.1 @ linux-x86-64");
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
      // Only the executable's digest stalls, past the call's deadline.
      stat: async (target) => {
        if (target === executable) {
          digestStarted.open();
          await release.opened;
        }
        return stat(target);
      },
    });
    const caller = new AbortController();
    try {
      const call = service.executeRizinCommand(
        {
          path,
          command: "iI",
          ...(interruption === "deadline" ? { command_timeout_ms: 50 } : {}),
        },
        { signal: caller.signal },
      );
      await within(digestStarted.opened, "executable digest");
      if (interruption === "cancellation") caller.abort("stop the digest");
      const result = await within(call, "interrupted digest");
      if (result.ok) throw new Error("Expected the digest to end the call");
      expect(result.error._tag).toBe(
        interruption === "deadline"
          ? "AnalysisTimeoutError"
          : "AnalysisCancelledError",
      );
      if (interruption === "cancellation")
        expect(result.error.cause).toBe("stop the digest");
      expect(result.error.diagnostics).toEqual({
        phase: "executable_digest",
        provider_executable_path: executable,
      });
      expect(run).not.toHaveBeenCalled();
    } finally {
      release.open();
      caller.abort("test cleanup");
    }
  },
);

posix(
  "runs the path it found, without searching PATH again, when the executable cannot be read for hashing",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    const run = versionProbeRunner(() => "rizin 0.9.1 @ linux-x86-64");
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: "rizin", PATH: dirname(executable) },
      // As for an executable that can be run but not read (mode 0111).
      digest: async (target, ...rest) =>
        target === executable
          ? Promise.reject(
              Object.assign(new Error("permission denied"), { code: "EACCES" }),
            )
          : digestFile(target, ...rest),
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (!result.ok) throw result.error;
    expect(run.mock.calls.map(([command]) => command)).toEqual([executable]);
    expect(result.value.provider.version).toBeNull();
    expect(result.value.parameters).toMatchObject({
      provider_executable_path: executable,
      provider_identity: "assumed",
    });
    expect(result.value.parameters).not.toHaveProperty(
      "provider_executable_sha256",
    );
    expect(result.value.limitations).toContain(
      "The executable version and supported formats are reported as unknown because the executable could not be read (EACCES).",
    );
  },
);

posix.each([
  ["ASCII", "x", 2_021],
  ["astral", "\u{1F600}", 505],
] as const)(
  "keeps at most 2,048 UTF-8 bytes of a banner of %s characters, cut between code points, and identifies nothing from it",
  async (_kind, filler, kept) => {
    const { executable, path } = await rizinExecutableFixture();
    // 27 bytes; with it, 2,021 ASCII characters or 505 four-byte ones fit.
    const prefix = "rizin 0.9.1 @ linux-x86-64 ";
    const run = versionProbeRunner(() => prefix + filler.repeat(5_000));
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (!result.ok) throw result.error;
    expect(result.value.provider.version).toBeNull();
    expect(result.value.parameters).toMatchObject({
      provider_version_banner: prefix + filler.repeat(kept),
      provider_version_banner_truncated: true,
      provider_identity: "assumed",
      provider_version_probe: { exit_code: 0, output_truncated: true },
    });
  },
);

posix.each([
  ["beyond the budget", " ".repeat(2_049), true],
  ["within the budget", "  ", false],
] as const)(
  "bounds a banner's leading whitespace %s as printed before identifying the tool",
  async (_case, padding, truncated) => {
    const { executable, path } = await rizinExecutableFixture();
    const line = `${padding}rizin 0.9.1 @ linux-x86-64  `;
    const run = versionProbeRunner(() => `${line}\n`);
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (!result.ok) throw result.error;
    expect(result.value.provider.version).toBe(truncated ? null : "0.9.1");
    expect(result.value.parameters).toMatchObject({
      provider_version_banner: truncated ? " ".repeat(2_048) : line,
      provider_version_banner_truncated: truncated,
      provider_identity: truncated ? "assumed" : "banner",
    });
  },
);

posix(
  "cuts a failed probe's diagnostic streams within 2,048 UTF-8 bytes, between code points",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    const astral = "\u{1F600}";
    const run = vi.fn(
      async (
        _command: string,
        args: readonly string[],
        _options?: ExecFileOutputOptions,
      ) => {
        if (args[0] === "-v")
          throw Object.assign(new Error("probe exited"), {
            code: 2,
            signal: null,
            stdout: astral.repeat(1_000),
            stderr: `a${astral.repeat(1_000)}`,
          });
        return { stdout: "command output", stderr: "" };
      },
    );
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (!result.ok) throw result.error;
    // 512 four-byte characters fill the budget; after "a", only 511 fit.
    expect(result.value.parameters.provider_version_probe).toMatchObject({
      stdout: astral.repeat(512),
      stderr: `a${astral.repeat(511)}`,
      output_truncated: true,
    });
  },
);
posix(
  "leaves the version unknown when the banner is not valid UTF-8",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    const run = vi.fn(
      async (
        _command: string,
        args: readonly string[],
        _options?: ExecFileOutputOptions,
      ) =>
        args[0] === "-v"
          ? {
              stdout: "rizin 0.9.� @ linux-x86-64",
              stderr: "warning �",
              stdoutInvalidUtf8: true,
              stderrInvalidUtf8: true,
            }
          : { stdout: "command output", stderr: "" },
    );
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (!result.ok) throw result.error;
    expect(result.value.provider).toEqual({
      id: "rizin",
      name: "Rizin",
      version: null,
    });
    expect(result.value.parameters).not.toHaveProperty(
      "provider_version_banner",
    );
    expect(result.value.parameters.provider_version_probe).toMatchObject({
      exit_code: 0,
      stdout_invalid_utf8: true,
      stderr_invalid_utf8: true,
    });
    expect(result.value.limitations).toEqual(
      expect.arrayContaining([
        expect.stringContaining(VERSION_PROBE_FAILURE_REASONS.undecodable),
      ]),
    );
    expect(result.value.raw_result).toMatchObject({ stdout: "command output" });
  },
);

posix(
  "leaves the version unknown when only the probe's stderr is not valid UTF-8",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    const run = vi.fn(
      async (
        _command: string,
        args: readonly string[],
        _options?: ExecFileOutputOptions,
      ) =>
        args[0] === "-v"
          ? {
              stdout: "rizin 0.9.1 @ linux-x86-64",
              stderr: "warning \ufffd",
              stderrInvalidUtf8: true,
            }
          : { stdout: "command output", stderr: "" },
    );
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (!result.ok) throw result.error;
    expect(result.value.provider.version).toBeNull();
    expect(result.value.parameters).not.toHaveProperty(
      "provider_version_banner",
    );
    expect(result.value.parameters.provider_version_probe).toMatchObject({
      exit_code: 0,
      stdout: "rizin 0.9.1 @ linux-x86-64",
      stderr: "warning \ufffd",
      stdout_invalid_utf8: false,
      stderr_invalid_utf8: true,
    });
  },
);

posix(
  "reports no exit status for a probe whose output was not fully collected",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    const bannerOutput = {
      stdout: {
        text: "rizin 0.9.1 @ linux-x86-64",
        bytes: 26,
        observedBytes: 26,
      },
    };
    const runOwned = vi.fn(
      async (request: { readonly arguments: readonly string[] }) => {
        if (request.arguments[0] !== "-v") return providerSnapshot();
        // The probe exits 0, but its output was not fully collected.
        throw new OwnedCommandFailure(
          "process",
          "Provider output collection failed.",
          providerSnapshot(bannerOutput),
          null,
          { collectionFailure: true },
        );
      },
    );
    const service = new TestReverseEngineeringService({
      runOwned,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const first = await service.executeRizinCommand({ path, command: "iI" });
    if (!first.ok) throw first.error;
    expect(first.value.provider.version).toBeNull();
    expect(first.value.parameters.provider_version_probe).toMatchObject({
      exit_code: null,
    });
  },
);

posix.each([
  ["failed", { stdout: true, stderr: false }],
  ["timed-out", { stdout: false, stderr: true }],
] as const)(
  "flags output that is not valid UTF-8 in a %s probe's diagnostics",
  async (outcome, invalid) => {
    const { executable, path } = await rizinExecutableFixture();
    const output = {
      stdout: {
        text: "rizin \uFFFD",
        bytes: 7,
        observedBytes: 7,
        ...(invalid.stdout ? { invalidUtf8: true as const } : {}),
      },
      stderr: {
        text: "warning \uFFFD",
        bytes: 9,
        observedBytes: 9,
        ...(invalid.stderr ? { invalidUtf8: true as const } : {}),
      },
    };
    const runOwned = vi.fn(
      async (request: { readonly arguments: readonly string[] }) => {
        if (request.arguments[0] !== "-v") return providerSnapshot();
        if (outcome === "timed-out")
          throw new OwnedCommandFailure(
            "timeout",
            "Command deadline elapsed.",
            providerSnapshot({ ...output, exitCode: null, signal: "SIGTERM" }),
          );
        return providerSnapshot({ ...output, exitCode: 2 });
      },
    );
    const service = new TestReverseEngineeringService({
      runOwned,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (!result.ok) throw result.error;
    expect(result.value.provider.version).toBeNull();
    expect(result.value.parameters.provider_version_probe).toMatchObject({
      exit_code: outcome === "failed" ? 2 : null,
      error_code: outcome === "timed-out" ? "ETIMEDOUT" : null,
      stdout_invalid_utf8: invalid.stdout,
      stderr_invalid_utf8: invalid.stderr,
    });
  },
);

posix.each(["cancelled", "cleanup-incomplete"] as const)(
  "keeps invalid UTF-8 flags in a %s probe's captured output",
  async (outcome) => {
    const { executable, path } = await rizinExecutableFixture();
    const caller = new AbortController();
    let stopped = false;
    const owner = {
      stop: async () =>
        stopped
          ? { status: "stopped" as const }
          : { status: "incomplete" as const, reason: "probe still running" },
    } as unknown as ProviderProcessSupervisor;
    const snapshot = providerSnapshot({
      exitCode: null,
      signal: "SIGTERM",
      stdout: {
        text: "rizin �",
        bytes: 7,
        observedBytes: 7,
        invalidUtf8: true,
      },
      stderr: {
        text: "warning �",
        bytes: 9,
        observedBytes: 9,
        invalidUtf8: true,
      },
    });
    const runOwned = vi.fn(
      async (request: { readonly arguments: readonly string[] }) => {
        if (request.arguments[0] !== "-v") return providerSnapshot();
        if (outcome === "cancelled") {
          caller.abort("stop the probe");
          throw new OwnedCommandFailure(
            "cancelled",
            "Command cancelled.",
            snapshot,
            null,
            { cancellation: { reason: "stop the probe" } },
          );
        }
        throw new OwnedCommandFailure(
          "process",
          "probe cleanup failed",
          snapshot,
          "probe still running",
          undefined,
          ["pid:9"],
          owner,
        );
      },
    );
    const service = new TestReverseEngineeringService({
      runOwned,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand(
      { path, command: "iI" },
      { signal: caller.signal },
    );
    if (result.ok) throw new Error("Expected the probe to end the call");
    expect(result.error._tag).toBe(
      outcome === "cancelled"
        ? "AnalysisCancelledError"
        : "AnalysisOutputError",
    );
    expect(result.error.capturedOutput).toMatchObject({
      stdout_invalid_utf8: true,
      stderr_invalid_utf8: true,
    });
    stopped = true;
    expect(await service.retryCleanup()).toEqual({ ok: true, value: null });
  },
);

posix(
  "identifies the tool a launcher runs on each call, though the launcher's digest stays the same",
  async () => {
    const { executable, path, digest } = await rizinExecutableFixture();
    // A version-manager shim: the same file delegates to whichever tool is selected.
    const banners = [
      "rizin 0.9.1 @ linux-x86-64",
      "rizin 0.8.1 @ linux-x86-64",
    ];
    const run = versionProbeRunner(
      () => banners[versionProbeCount(run) - 1] ?? "unexpected probe",
    );
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const versions: (string | null)[] = [];
    const digests: unknown[] = [];
    for (const command of ["iI", "iS"]) {
      const result = await service.executeRizinCommand({ path, command });
      if (!result.ok) throw result.error;
      versions.push(result.value.provider.version);
      digests.push(result.value.parameters.provider_executable_sha256);
    }
    expect(versions).toEqual(["0.9.1", "0.8.1"]);
    expect(digests).toEqual([await digest(), await digest()]);
  },
);

posix.each([
  [
    "an empty first line",
    "\nrizin 0.9.1 @ linux-x86-64\n",
    "warning: the banner moved to the second line\n",
    "",
  ],
  [
    "a Usage: banner",
    "Usage: rizin [-ACdfLMnNqStuvwzX]\n -v  show version information\n",
    "",
    "Usage: rizin [-ACdfLMnNqStuvwzX]",
  ],
] as const)(
  "keeps the probe's diagnostics beside %s that identifies no tool",
  async (_case, stdout, stderr, banner) => {
    const { executable, path } = await rizinExecutableFixture();
    const run = vi.fn(
      async (
        _command: string,
        args: readonly string[],
        _options?: ExecFileOutputOptions,
      ) =>
        args[0] === "-v"
          ? { stdout, stderr }
          : { stdout: "command output", stderr: "" },
    );
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (!result.ok) throw result.error;
    expect(result.value.provider.version).toBeNull();
    expect(result.value.parameters).toMatchObject({
      provider_identity: "assumed",
      provider_version_banner: banner,
      provider_version_probe: {
        exit_code: 0,
        stdout,
        stderr,
        output_truncated: false,
      },
    });
  },
);

posix(
  "reports no version from a banner cut inside its version token",
  async () => {
    const { executable, path } = await rizinExecutableFixture();
    // The version token runs past the 2,048-byte cut.
    const line = `rizin ${"1".repeat(3_000)} @ linux-x86-64`;
    const run = versionProbeRunner(() => line);
    const service = new TestReverseEngineeringService({
      run,
      lookup: lookupExecutable,
      environment: { REA_RIZIN_COMMAND: executable },
    });
    const result = await service.executeRizinCommand({ path, command: "iI" });
    if (!result.ok) throw result.error;
    expect(result.value.provider).toEqual({
      id: "rizin",
      name: "Rizin",
      version: null,
    });
    expect(result.value.parameters).toMatchObject({
      provider_version_banner: line.slice(0, 2_048),
      provider_version_banner_truncated: true,
      provider_identity: "assumed",
      provider_version_probe: { exit_code: 0, output_truncated: true },
    });
  },
);
