import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import {
  ProviderProcessSupervisor,
  type ProviderProcessSnapshot,
} from "../process/ProviderProcess.js";
import {
  OwnedCommandFailure,
  runOwnedCommand,
} from "../process/OwnedCommand.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { FirmwareDoctorHost } from "./FirmwareDoctor.js";
import * as commandPath from "../process/ArtifactCommandPath.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { runDoctor } from "../application/Doctor.js";
import { createDoctorHostFixture } from "../application/Doctor.fixture.js";
import { FirmwareDoctor } from "./FirmwareDoctor.js";

const HEADER =
  "The following executables found installed, which are needed by unblob:";

it("reports unsupported firmware hosts without launching configured tools", async () => {
  const doctor = new FirmwareDoctor(
    { REA_BINWALK_COMMAND: "/not/launched" },
    "darwin",
  );
  const inspections = await doctor.inspect();
  expect(inspections).toHaveLength(2);
  for (const inspection of inspections) {
    expect(inspection.available).toBe(false);
    expect(inspection.checks).toContainEqual(
      expect.objectContaining({
        name: "platform",
        ok: false,
        classification: "unsupported_host",
      }),
    );
    expect(inspection.checks.some(({ name }) => name === "version")).toBe(
      false,
    );
  }
  expect(await doctor.close()).toBeUndefined();
});

it("preserves doctor cancellation before firmware probes run", async () => {
  const controller = new AbortController();
  controller.abort("stop doctor");
  const doctor = new FirmwareDoctor({}, "linux", {}, controller.signal);
  await expect(doctor.inspect()).rejects.toBeInstanceOf(AnalysisCancelledError);
  expect(await doctor.close()).toBeUndefined();
});

const linuxIt = it.skipIf(process.platform !== "linux");

it("does not launch host probes for unconfigured optional firmware tools", async () => {
  const prepareOwnership =
    vi.fn<NonNullable<FirmwareDoctorHost["prepareOwnership"]>>();
  const runCommand = vi.fn<NonNullable<FirmwareDoctorHost["runCommand"]>>();
  const doctor = new FirmwareDoctor({}, "linux", {
    prepareOwnership,
    runCommand,
  });
  const inspections = await doctor.inspect();
  expect(inspections.map(({ configured }) => configured)).toEqual([
    false,
    false,
  ]);
  expect(prepareOwnership).not.toHaveBeenCalled();
  expect(runCommand).not.toHaveBeenCalled();
  expect(await doctor.close()).toBeUndefined();
});

linuxIt.each(["limiter", "engine"] as const)(
  "preserves caller cancellation during %s executable path admission",
  async (phase) => {
    const { environment, host } = await fixture();
    const controller = new AbortController();
    const reason = { request: `cancel ${phase} path admission` };
    const selectedPath =
      phase === "limiter"
        ? "/usr/bin/prlimit"
        : environment.REA_BINWALK_COMMAND;
    const select = commandPath.selectArtifactCommandPath;
    const selection = vi
      .spyOn(commandPath, "selectArtifactCommandPath")
      .mockImplementation((path, signal) => {
        const pending = select(path, signal);
        if (path === selectedPath) controller.abort(reason);
        return pending;
      });
    const doctor = new FirmwareDoctor(
      environment,
      "linux",
      host,
      controller.signal,
    );
    try {
      await expect(doctor.inspect()).rejects.toMatchObject({
        _tag: "AnalysisCancelledError",
        operation: "doctor",
        cause: reason,
      });
      expect(host.runCommand).toHaveBeenCalledTimes(
        phase === "limiter" ? 0 : 1,
      );
    } finally {
      selection.mockRestore();
      await doctor.close();
    }
  },
);

linuxIt(
  "exposes configured firmware readiness independently of absent native engines",
  async () => {
    const { doctor } = await fixture();
    const inspections = await doctor.inspect();
    expect(
      inspections.map(({ id, available, providerVersion }) => ({
        id,
        available,
        providerVersion,
      })),
    ).toEqual([
      { id: "binwalk", available: true, providerVersion: "3.1.0" },
      { id: "unblob", available: true, providerVersion: "26.6.4" },
    ]);
    expect(
      inspections.every(
        ({ registrationEnvironment }) =>
          Object.keys(registrationEnvironment).length === 0,
      ),
    ).toBe(true);
    const report = await runDoctor(
      undefined,
      createDoctorHostFixture({
        executable: () => Promise.resolve(false),
        providerInspections: () => Promise.resolve(inspections),
      }),
      { providers: ["binwalk", "unblob"] },
    );
    expect(report.healthy).toBe(true);
    expect(
      report.scope_checks.some(({ name }) => name.startsWith("hopper")),
    ).toBe(false);
    expect(report.informational_checks).toContainEqual(
      expect.objectContaining({ name: "hopper", ok: false }),
    );
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt(
  "treats absent firmware tools as optional and names their settings",
  async () => {
    const doctor = new FirmwareDoctor({ PATH: process.env.PATH });
    const inspections = await doctor.inspect();
    expect(
      inspections.every(
        ({ configured, available }) => !configured && !available,
      ),
    ).toBe(true);
    expect(inspections[0]?.checks).toContainEqual(
      expect.objectContaining({
        name: "configuration",
        classification: "missing_analysis_engine",
        remediation: expect.stringContaining("REA_BINWALK_COMMAND"),
      }),
    );
    const report = await runDoctor(
      undefined,
      createDoctorHostFixture({
        providerInspections: () => Promise.resolve(inspections),
      }),
    );
    expect(report.healthy).toBe(true);
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt.each(["relative", "directory", "not-executable", "missing"])(
  "rejects %s engine paths while preserving a healthy peer",
  async (kind) => {
    const { environment, root, host } = await fixture();
    let path = join(root, kind);
    if (kind === "relative") path = "binwalk";
    if (kind === "directory") await mkdir(path);
    if (kind === "not-executable")
      await writeFile(path, "not executable", { mode: 0o600 });
    const doctor = new FirmwareDoctor(
      {
        ...environment,
        REA_BINWALK_COMMAND: path,
      },
      "linux",
      host,
    );
    const [binwalk, unblob] = await doctor.inspect();
    expect(binwalk).toMatchObject({ configured: true, available: false });
    expect(binwalk?.checks).toContainEqual(
      expect.objectContaining({
        name: "configuration",
        ok: false,
        classification: "config_drift",
      }),
    );
    expect(unblob?.available).toBe(true);
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt.each(["binwalk 3.2.0", "nonsense"])(
  "refuses an unsupported or unknown version banner: %s",
  async (banner) => {
    const { doctor } = await fixture({ binwalkBanner: banner });
    const [binwalk, unblob] = await doctor.inspect();
    expect(binwalk).toMatchObject({
      available: false,
      providerVersion: null,
    });
    expect(binwalk?.checks).toContainEqual(
      expect.objectContaining({ name: "version", ok: false }),
    );
    expect(unblob?.available).toBe(true);
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt(
  "labels compatible patch releases as accepted but unverified",
  async () => {
    const { doctor } = await fixture({ binwalkBanner: "binwalk 3.1.2" });
    const [binwalk] = await doctor.inspect();
    expect(binwalk).toMatchObject({
      available: true,
      providerVersion: "3.1.2",
    });
    expect(binwalk?.checks).toContainEqual(
      expect.objectContaining({
        name: "version",
        detail: expect.stringContaining("verified against 3.1.0"),
      }),
    );
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt(
  "retains missing external extractors from Unblob's ordinary exit 1 report",
  async () => {
    const { doctor } = await fixture({
      dependencies: `${HEADER}\n    7z    ✓\n    sasquatch    ✗\n`,
      dependencyExit: 1,
    });
    const [binwalk, unblob] = await doctor.inspect();
    expect(binwalk?.available).toBe(true);
    expect(unblob).toMatchObject({
      available: false,
      providerVersion: "26.6.4",
    });
    expect(unblob?.checks).toContainEqual(
      expect.objectContaining({
        name: "external-dependencies",
        classification: "missing_dependency",
        details: { installed: ["7z"], missing: ["sasquatch"] },
      }),
    );
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt.each([
  ["unexpected output", 0],
  [`${HEADER}\n`, 0],
  [`${HEADER}\n    7z    ✓\n    7z    ✓\n`, 0],
  [`${HEADER}\n    7z    ✗\n`, 0],
  [`${HEADER}\n    7z    ✓\n`, 1],
  [`${HEADER}\n    7z    ✓\n`, 2],
])(
  "preserves unknown dependency output or inconsistent exit %s/%s",
  async (dependencies, dependencyExit) => {
    const { doctor } = await fixture({ dependencies, dependencyExit });
    const [, unblob] = await doctor.inspect();
    expect(unblob?.available).toBe(false);
    expect(unblob?.checks).toContainEqual(
      expect.objectContaining({
        name: "external-dependencies",
        classification: "unknown",
        ok: false,
      }),
    );
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt(
  "reports missing ps before launching any selected provider",
  async () => {
    const { environment, root } = await fixture();
    const doctor = new FirmwareDoctor({ ...environment, PATH: root });
    const inspections = await doctor.inspect();
    for (const inspection of inspections) {
      expect(inspection.available).toBe(false);
      expect(inspection.checks).toContainEqual(
        expect.objectContaining({
          name: "ps",
          ok: false,
          detail: expect.stringContaining("procps-compatible ps"),
        }),
      );
      expect(inspection.checks.some(({ name }) => name === "version")).toBe(
        false,
      );
    }
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt(
  "accepts a renamed util-linux prlimit and probes the configured engines",
  async () => {
    const { environment, root, host } = await fixture({
      limiterBanner: "prlimit-limiter from util-linux 2.39.3\n",
    });
    const limiter = join(root, "prlimit-limiter");
    await executable(limiter, "exit 9\n");
    const doctor = new FirmwareDoctor(
      { ...environment, REA_FIRMWARE_PRLIMIT_COMMAND: limiter },
      "linux",
      host,
    );
    const inspections = await doctor.inspect();
    expect(inspections.map(({ id, available }) => ({ id, available }))).toEqual(
      [
        { id: "binwalk", available: true },
        { id: "unblob", available: true },
      ],
    );
    expect(host.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: limiter, arguments: ["--version"] }),
      expect.any(Object),
      expect.any(Object),
    );
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt(
  "rejects a non-util-linux limiter without probing engines",
  async () => {
    const { environment, root, host } = await fixture();
    const limiter = join(root, "other-prlimit");
    await executable(limiter, "printf 'not util-linux\\n'\n");
    const doctor = new FirmwareDoctor(
      {
        ...environment,
        REA_FIRMWARE_PRLIMIT_COMMAND: limiter,
      },
      "linux",
      { ...host, runCommand: async () => snapshot("not util-linux", 0) },
    );
    const inspections = await doctor.inspect();
    expect(inspections.every(({ available }) => !available)).toBe(true);
    expect(inspections[0]?.checks).toContainEqual(
      expect.objectContaining({ name: "prlimit", ok: false }),
    );
    expect(inspections[0]?.checks.some(({ name }) => name === "version")).toBe(
      false,
    );
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt.each(["timeout", "output-limit", "process"] as const)(
  "reports a %s probe failure without aborting the peer inspection",
  async (reason) => {
    const { root, environment, host } = await fixture();
    const doctor = new FirmwareDoctor(environment, "linux", {
      ...host,
      runCommand: async (spawn, limits, options) => {
        if (spawn.arguments.includes(join(root, "binwalk")))
          throw new OwnedCommandFailure(
            reason,
            `Observed ${reason}`,
            snapshot("partial banner", 1),
          );
        if (host.runCommand === undefined)
          throw new Error("Expected recording host");
        return host.runCommand(spawn, limits, options);
      },
    });
    const [binwalk, unblob] = await doctor.inspect();
    expect(binwalk?.available).toBe(false);
    expect(binwalk?.checks).toContainEqual(
      expect.objectContaining({
        name: "version",
        classification: "runtime_failure",
        detail: expect.stringContaining("partial banner"),
      }),
    );
    expect(unblob?.available).toBe(true);
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt(
  "uses the command owner's cancellation reason and captured output",
  async () => {
    const { environment, host } = await fixture();
    const controller = new AbortController();
    const reason = { request: "owner-observed cancellation" };
    const run = vi.fn<NonNullable<FirmwareDoctorHost["runCommand"]>>(
      async () => {
        throw new OwnedCommandFailure(
          "cancelled",
          "Command cancelled during finalization",
          snapshot("completed output", 0, "captured diagnostic"),
          null,
          { cancellation: { reason } },
        );
      },
    );
    const doctor = new FirmwareDoctor(
      environment,
      "linux",
      { ...host, runCommand: run },
      controller.signal,
    );
    const failure: unknown = await doctor
      .inspect()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    if (!(failure instanceof AnalysisCancelledError)) throw failure;
    expect(controller.signal.aborted).toBe(false);
    expect(failure.cause).toBe(reason);
    expect(projectAnalysisError(failure)).toMatchObject({
      code: "cancelled",
      details: {
        captured_output: {
          stdout: "completed output",
          stderr: "captured diagnostic",
          exit_code: 0,
          truncated: false,
        },
      },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt.each([
  { reason: "process", tag: "ProviderAdapterError", code: "execution_failure" },
  { reason: "timeout", tag: "AnalysisTimeoutError", code: "provider_timeout" },
  {
    reason: "output-limit",
    tag: "AnalysisResourceConstraintError",
    code: "resource_constraint",
  },
] as const)(
  "keeps an earlier $reason failure and output when cleanup observes cancellation",
  async ({ reason, tag, code }) => {
    const { environment, host } = await fixture();
    const controller = new AbortController();
    const cancellation = { request: "cancel during probe cleanup" };
    const physical = new OwnedCommandFailure(
      reason,
      `Original ${reason} failure`,
      {
        ...snapshot("earlier stdout", 7, "earlier stderr"),
        diagnosticTruncated: reason === "output-limit",
      },
      null,
      { cancellation: { reason: cancellation } },
    );
    const run = vi.fn<NonNullable<FirmwareDoctorHost["runCommand"]>>(
      async () => {
        controller.abort(cancellation);
        throw physical;
      },
    );
    const doctor = new FirmwareDoctor(
      environment,
      "linux",
      { ...host, runCommand: run },
      controller.signal,
    );
    const failure: unknown = await doctor
      .inspect()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisError);
    if (!(failure instanceof AnalysisError)) throw failure;
    expect(failure._tag).toBe(tag);
    expect(failure.cause).toBe(physical);
    expect(failure.secondaryFailures).toHaveLength(1);
    expect(failure.secondaryFailures[0]).toBeInstanceOf(AnalysisCancelledError);
    expect(failure.secondaryFailures[0]?.cause).toBe(cancellation);
    expect(projectAnalysisError(failure)).toMatchObject({
      code,
      details: {
        captured_output: {
          stdout: "earlier stdout",
          stderr: "earlier stderr",
          exit_code: 7,
          truncated: reason === "output-limit",
        },
        diagnostics: {
          firmware_probe: { reason, message: `Original ${reason} failure` },
        },
      },
    });
    expect(run).toHaveBeenCalledOnce();
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt(
  "keeps an unrelated AbortError primary when the caller also cancels",
  async () => {
    const { environment, host } = await fixture();
    const controller = new AbortController();
    const physical = new Error("physical preparation failure");
    physical.name = "AbortError";
    const cancellation = { request: "later caller cancellation" };
    const run = vi.fn<NonNullable<FirmwareDoctorHost["runCommand"]>>(
      async () => {
        controller.abort(cancellation);
        throw physical;
      },
    );
    const doctor = new FirmwareDoctor(
      environment,
      "linux",
      { ...host, runCommand: run },
      controller.signal,
    );
    const failure: unknown = await doctor
      .inspect()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisError);
    if (!(failure instanceof AnalysisError)) throw failure;
    expect(failure._tag).toBe("ProviderAdapterError");
    expect(failure.cause).toBe(physical);
    expect(failure.secondaryFailures[0]?.cause).toBe(cancellation);
    expect(run).toHaveBeenCalledOnce();
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt(
  "retains a failed completed inspection when the next engine path is cancelled",
  async () => {
    const { environment, host } = await fixture();
    const controller = new AbortController();
    const cancellation = { request: "cancel next engine admission" };
    const physical = new OwnedCommandFailure(
      "process",
      "earlier Binwalk failure",
      snapshot("partial binwalk version", 7, "binwalk diagnostic"),
    );
    const run = vi.fn<NonNullable<FirmwareDoctorHost["runCommand"]>>(
      async (spawn, limits, options) => {
        if (spawn.arguments.includes(environment.REA_BINWALK_COMMAND))
          throw physical;
        if (host.runCommand === undefined)
          throw new Error("Expected recording host");
        return host.runCommand(spawn, limits, options);
      },
    );
    const select = commandPath.selectArtifactCommandPath;
    const selection = vi
      .spyOn(commandPath, "selectArtifactCommandPath")
      .mockImplementation((path, signal) => {
        if (path === environment.REA_UNBLOB_COMMAND)
          controller.abort(cancellation);
        return select(path, signal);
      });
    const doctor = new FirmwareDoctor(
      environment,
      "linux",
      { ...host, runCommand: run },
      controller.signal,
    );
    try {
      const failure: unknown = await doctor
        .inspect()
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(AnalysisError);
      if (!(failure instanceof AnalysisError)) throw failure;
      expect(failure._tag).toBe("ProviderAdapterError");
      expect(failure.cause).toBe(physical);
      expect(failure.secondaryFailures[0]?.cause).toBe(cancellation);
      expect(projectAnalysisError(failure)).toMatchObject({
        code: "execution_failure",
        details: {
          captured_output: {
            stdout: "partial binwalk version",
            stderr: "binwalk diagnostic",
          },
          diagnostics: {
            firmware_inspections: [
              {
                id: "binwalk",
                available: false,
                checks: expect.arrayContaining([
                  expect.objectContaining({
                    name: "version",
                    ok: false,
                    detail: expect.stringContaining("earlier Binwalk failure"),
                  }),
                ]),
              },
            ],
            firmware_inspection_count: { completed: 1, total: 2 },
          },
        },
      });
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      selection.mockRestore();
      await doctor.close();
    }
  },
);

linuxIt(
  "preserves both probe failures when cancellation follows the second failure",
  async () => {
    const { environment, host } = await fixture();
    const controller = new AbortController();
    const cancellation = {
      request: "cancel during second failed probe cleanup",
    };
    const first = new OwnedCommandFailure(
      "process",
      "first Binwalk failure",
      snapshot("binwalk output", 7, "binwalk failure detail"),
    );
    const second = new OwnedCommandFailure(
      "output-limit",
      "second Unblob output overflow",
      {
        ...snapshot("unblob output", 8, "unblob failure detail"),
        diagnosticTruncated: true,
      },
      null,
      { cancellation: { reason: cancellation } },
    );
    const run = vi.fn<NonNullable<FirmwareDoctorHost["runCommand"]>>(
      async (spawn, limits, options) => {
        if (spawn.arguments.includes(environment.REA_BINWALK_COMMAND))
          throw first;
        if (spawn.arguments.includes(environment.REA_UNBLOB_COMMAND)) {
          controller.abort(cancellation);
          throw second;
        }
        if (host.runCommand === undefined)
          throw new Error("Expected recording host");
        return host.runCommand(spawn, limits, options);
      },
    );
    const doctor = new FirmwareDoctor(
      environment,
      "linux",
      { ...host, runCommand: run },
      controller.signal,
    );
    const failure: unknown = await doctor
      .inspect()
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisError);
    if (!(failure instanceof AnalysisError)) throw failure;
    expect(failure._tag).toBe("ProviderAdapterError");
    expect(failure.cause).toBe(first);
    expect(
      failure.secondaryFailures.find(
        (error) => error._tag === "AnalysisResourceConstraintError",
      )?.cause,
    ).toBe(second);
    expect(
      failure.secondaryFailures.find(
        (error) => error instanceof AnalysisCancelledError,
      )?.cause,
    ).toBe(cancellation);
    expect(projectAnalysisError(failure)).toMatchObject({
      code: "execution_failure",
      details: {
        captured_output: {
          stdout: "binwalk output",
          stderr: "binwalk failure detail",
          exit_code: 7,
        },
        diagnostics: {
          firmware_secondary_probe_failures: [
            {
              code: "resource_constraint",
              details: {
                captured_output: {
                  stdout: "unblob output",
                  stderr: "unblob failure detail",
                  exit_code: 8,
                  truncated: true,
                },
              },
            },
          ],
        },
      },
    });
    expect(run).toHaveBeenCalledTimes(3);
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt.each([false, true])(
  "preserves the owned-command failure through actual supervision cleanup (refused: %s)",
  async (refused) => {
    const { environment, host } = await fixture();
    const controller = new AbortController();
    const cancellation = { request: "cancel in owned cleanup" };
    const processError = new Error("authored process collection failure");
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(() => false),
    });
    let cleanupCalls = 0;
    const cleanup = async () => {
      cleanupCalls++;
      controller.abort(cancellation);
      return refused && cleanupCalls === 1
        ? {
            cleaned: false as const,
            reason: "exact probe owner is still pending",
          }
        : { cleaned: true as const, signaled: false };
    };
    const run = vi.fn<NonNullable<FirmwareDoctorHost["runCommand"]>>(
      (spawn, limits, options) =>
        runOwnedCommand(spawn, limits, {
          ...options,
          launcher: async () => {
            setImmediate(() => {
              child.stdout.end("owned stdout");
              child.stderr.end("owned stderr");
              child.emit("error", processError);
              child.exitCode = 7;
              child.emit("exit", 7, null);
              child.emit("close", 7, null);
            });
            return {
              process: child,
              ownership: {
                runId: "firmware-doctor-finalization",
                leaderPid: 41234,
                processGroupId: 41234,
              },
              cleanup,
            };
          },
        }),
    );
    const doctor = new FirmwareDoctor(
      environment,
      "linux",
      { ...host, runCommand: run },
      controller.signal,
    );
    try {
      const failure: unknown = await doctor
        .inspect()
        .catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(AnalysisError);
      if (!(failure instanceof AnalysisError)) throw failure;
      expect(failure).toMatchObject({
        _tag: "ProviderAdapterError",
        cause: { reason: "process", processError },
        capturedOutput: {
          stdout: "owned stdout",
          stderr: "owned stderr",
          exit_code: 7,
        },
      });
      expect(failure.secondaryFailures[0]?.cause).toBe(cancellation);
      expect(doctor.hasPendingCleanup).toBe(refused);
      expect(cleanupCalls).toBe(1);
      expect(run).toHaveBeenCalledOnce();
      expect(await doctor.close()).toBeUndefined();
      expect(cleanupCalls).toBe(refused ? 2 : 1);
      expect(doctor.hasPendingCleanup).toBe(false);
      expect(failure._tag).toBe("ProviderAdapterError");
      expect(failure.capturedOutput?.stderr).toBe("owned stderr");
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      await doctor.close();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  },
);

linuxIt(
  "reports real process-table overflow as an unknown prerequisite without launching tools",
  async () => {
    const { environment, root } = await fixture();
    const ps = join(root, "ps");
    await writeFile(
      ps,
      `#!${process.execPath}\nprocess.stdout.write("é".repeat(65536));\n`,
    );
    await chmod(ps, 0o700);
    const run = vi.fn<NonNullable<FirmwareDoctorHost["runCommand"]>>();
    const doctor = new FirmwareDoctor({ ...environment, PATH: root }, "linux", {
      runCommand: run,
    });
    const inspections = await doctor.inspect();
    expect(inspections).toHaveLength(2);
    for (const inspection of inspections) {
      expect(inspection.available).toBe(false);
      expect(inspection.checks).toContainEqual(
        expect.objectContaining({
          name: "ps",
          ok: false,
          classification: "unknown",
          detail: expect.stringContaining("65536-byte"),
          details: expect.objectContaining({
            reason: "output_limit",
            max_output_bytes_per_stream: 65536,
          }),
        }),
      );
      expect(inspection.checks.some(({ name }) => name === "version")).toBe(
        false,
      );
    }
    expect(run).not.toHaveBeenCalled();
    expect(await doctor.close()).toBeUndefined();
  },
);

linuxIt(
  "retains incomplete cleanup, blocks later launches and retries on close",
  async () => {
    const { environment, host } = await fixture();
    const process = Object.assign(new EventEmitter(), {
      stdout: null,
      stderr: null,
      exitCode: 0,
      signalCode: null,
      kill: () => false,
    });
    const owner = new ProviderProcessSupervisor({
      process,
      ownsProcessLifetime: false,
    });
    const stop = vi
      .spyOn(owner, "stop")
      .mockResolvedValueOnce({
        status: "incomplete",
        reason: "Fixture ownership unavailable",
      })
      .mockResolvedValue({ status: "verified-cleanup" });
    const run = vi.fn<NonNullable<FirmwareDoctorHost["runCommand"]>>(
      async (_spawn, _limits, options) => {
        options?.retainCleanup?.(owner, {
          status: "incomplete",
          reason: "Fixture ownership unavailable",
        });
        throw new OwnedCommandFailure("process", "Fixture cleanup incomplete");
      },
    );
    const doctor = new FirmwareDoctor(environment, "linux", {
      ...host,
      runCommand: run,
    });
    try {
      const inspections = await doctor.inspect();
      expect(inspections.every(({ available }) => !available)).toBe(true);
      expect(run).toHaveBeenCalledTimes(1);
      expect(await doctor.close()).toContain("Fixture ownership unavailable");
      expect(await doctor.close()).toBeUndefined();
      expect(stop).toHaveBeenCalledTimes(2);
    } finally {
      owner.dispose();
    }
  },
);

const executable = async (path: string, body: string): Promise<void> => {
  await writeFile(path, `#!/bin/sh\n${body}`);
  await chmod(path, 0o700);
};

const fixture = async (
  options: {
    binwalkBanner?: string;
    limiterBanner?: string;
    dependencies?: string;
    dependencyExit?: number;
  } = {},
) => {
  const root = await createTestTempDirectory("rea-firmware-doctor-");
  const binwalk = join(root, "binwalk");
  const unblob = join(root, "unblob");
  // File admission is real; the recording host below supplies tool observations.
  await executable(binwalk, "exit 9\n");
  await executable(unblob, "exit 9\n");
  const environment = {
    PATH: process.env.PATH,
    REA_BINWALK_COMMAND: binwalk,
    REA_UNBLOB_COMMAND: unblob,
  };
  const host: FirmwareDoctorHost = {
    prepareOwnership: async () => {},
    runCommand: vi.fn(async (spawn, limits) => {
      expect(limits.timeoutMs).toBe(5000);
      expect(limits.diagnosticBytes).toBe(64 * 1024);
      if (spawn.arguments.length === 1 && spawn.arguments[0] === "--version")
        return snapshot(
          options.limiterBanner ?? "prlimit from util-linux 2.39.3\n",
          0,
        );
      expect(spawn.arguments.slice(0, 5)).toEqual([
        "--as=1073741824:1073741824",
        "--fsize=0:0",
        "--cpu=5:5",
        "--core=0:0",
        "--",
      ]);
      if (spawn.arguments[5] === binwalk)
        return snapshot(options.binwalkBanner ?? "binwalk 3.1.0", 0);
      expect(spawn.arguments[5]).toBe(unblob);
      return spawn.arguments[6] === "--version"
        ? snapshot("26.6.4", 0)
        : snapshot(
            options.dependencies ?? `${HEADER}\n    7z    ✓\n`,
            options.dependencyExit ?? 0,
          );
    }),
  };
  return {
    root,
    environment,
    host,
    doctor: new FirmwareDoctor(environment, "linux", host),
  };
};

const snapshot = (
  text: string,
  exitCode: number,
  stderr = "",
): ProviderProcessSnapshot => ({
  stdout: {
    text,
    bytes: Buffer.byteLength(text),
    observedBytes: Buffer.byteLength(text),
  },
  stderr: {
    text: stderr,
    bytes: Buffer.byteLength(stderr),
    observedBytes: Buffer.byteLength(stderr),
  },
  exitCode,
  signal: null,
});
