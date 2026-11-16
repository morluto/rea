import { UnclassifiedProviderFailure } from "../../../src/domain/unclassifiedProviderFailure.js";
import { HOST_PLATFORM } from "../../../src/platform/HostPlatform.js";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { expect, it, onTestFinished, test, vi } from "vitest";
import { phaseGate } from "../../support/lifecycleHarness.js";
import { runPcapCommand } from "../../../src/pcap/PcapCommand.js";
import { Deadline } from "../../../src/domain/deadline.js";
import * as ownership from "../../../src/process/ProcessOwnershipObservation.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import type { ProviderProcessSupervisor } from "../../../src/process/ProviderProcess.js";
import {
  AnalysisCancelledError,
  AnalysisProtocolError,
  AnalysisUnsupportedTargetError,
} from "../../../src/domain/analysisErrorCore.js";

const posixIt = test.skipIf(process.platform === "win32");
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { OwnedCommandFailure } from "../../../src/process/OwnedCommand.js";
import { selectArtifactCommandPath } from "../../../src/process/ArtifactCommandPath.js";

it.skipIf(process.platform !== "darwin")(
  "preserves opaque cancellation during native ownership preparation without acquiring caller resources",
  async () => {
    const controller = new AbortController();
    const reason = new ProviderCleanupError("caller", ["foreign-resource"], {});
    const prepare = vi
      .spyOn(ownership.systemProcessOwnershipHost, "prepare")
      .mockImplementationOnce(async () => {
        controller.abort(reason);
      });
    onTestFinished(() => prepare.mockRestore());
    const launcher = vi.fn(async () => {
      throw new Error("Cancelled preparation must not launch the tool");
    });
    const failure = await runPcapCommand({
      platform: HOST_PLATFORM.platform,
      operation: "inspect_pcap_client",
      command: process.execPath,
      arguments: ["--version"],
      limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
      environment: {},
      signal: controller.signal,
      launcher,
      retain: () => {
        throw new Error("No provider resources were acquired");
      },
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    if (!(failure instanceof AnalysisCancelledError)) throw failure;
    expect(failure.cause).toBe(reason);
    expect(failure.cleanupIncomplete).toBe(false);
    expect(failure.cleanupResources).toEqual([]);
    expect(reason.cleanupIncomplete).toBe(true);
    expect(launcher).not.toHaveBeenCalled();
  },
);

it("preserves a failed producer when cancellation arrives during its final cleanup", async () => {
  const controller = new AbortController();
  const reason = { request: "cancel during cleanup" };
  const failure = await runPcapCommand({
    platform: HOST_PLATFORM.platform,
    operation: "inspect_pcap_capture",
    command: process.execPath,
    arguments: [
      "-e",
      'process.stderr.write("authored producer failure"); process.exitCode = 7',
    ],
    inputPath: "/authored-capture.pcap",
    limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
    environment: {},
    signal: controller.signal,
    launcher: async (spawn) => {
      const launched = await spawnOwnedProviderProcess(spawn);
      const cleanup =
        launched.cleanup ??
        (() => cleanupOwnedProcessGroup(launched.ownership));
      return {
        ...launched,
        cleanup: async () => {
          const result = await cleanup();
          controller.abort(reason);
          return result;
        },
      };
    },
    retain: (owner) =>
      onTestFinished(async () => {
        expect((await owner.stop()).status).not.toBe("incomplete");
      }),
  }).catch((cause: unknown) => cause);
  expect(controller.signal.aborted).toBe(true);
  expect(failure).toBeInstanceOf(UnclassifiedProviderFailure);
  if (!(failure instanceof UnclassifiedProviderFailure)) throw failure;
  expect(failure.examined).toMatchObject({
    failure_kind: "exited",
    exit_code: 7,
  });
  expect(failure.cause).toBeInstanceOf(OwnedCommandFailure);
  expect((failure.cause as OwnedCommandFailure).reason).toBe("process");
  expect(failure.capturedOutput).toMatchObject({
    stderr: "authored producer failure",
    exit_code: 7,
  });
});

it.each([
  null,
  "opaque caller cancellation",
  new ProviderCleanupError("caller", ["caller-owned-resource"], {
    reason: "unrelated cleanup",
  }),
])(
  "preserves the exact active command cancellation reason %s",
  async (reason) => {
    const controller = new AbortController();
    const failure = await runPcapCommand({
      platform: HOST_PLATFORM.platform,
      operation: "inspect_pcap_client",
      command: process.execPath,
      arguments: [
        "-e",
        'process.stdout.write("ready"); setInterval(() => {}, 1000)',
      ],
      limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
      environment: {},
      signal: controller.signal,
      launcher: async (spawn) => {
        const launched = await spawnOwnedProviderProcess(spawn);
        launched.process.stdout?.once("data", () => controller.abort(reason));
        return launched;
      },
      retain: (owner) =>
        onTestFinished(async () => {
          expect((await owner.stop()).status).not.toBe("incomplete");
        }),
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AnalysisCancelledError);
    if (!(failure instanceof AnalysisCancelledError)) throw failure;
    expect(failure.cause).toBe(reason);
    expect(failure.cleanupIncomplete).toBe(false);
    expect(failure.cleanupResources).toEqual([]);
    if (reason instanceof ProviderCleanupError)
      expect(reason.cleanupIncomplete).toBe(true);
  },
);

it.skipIf(process.platform !== "darwin")(
  "does not spend the tool execution deadline preparing native ownership",
  async () => {
    const original = ownership.prepareProcessOwnershipInspection;
    const ownershipPreparation = phaseGate();
    let first = true;
    const prepare = vi
      .spyOn(ownership, "prepareProcessOwnershipInspection")
      .mockImplementation(async (signal) => {
        await original(signal);
        if (first) {
          first = false;
          await ownershipPreparation.hold();
        }
      });
    const timeoutMs = 4321;
    const deadlines = vi.spyOn(Deadline, "after");
    const commandDeadlines = () =>
      deadlines.mock.calls.filter(
        ([milliseconds]) => milliseconds === timeoutMs,
      );
    onTestFinished(() => {
      deadlines.mockRestore();
      prepare.mockRestore();
      ownershipPreparation.release();
    });
    const pending = runPcapCommand({
      platform: HOST_PLATFORM.platform,
      operation: "inspect_pcap_client",
      command: process.execPath,
      arguments: ["--version"],
      limits: { timeoutMs, maxOutputBytes: 1024 },
      environment: {},
      signal: undefined,
      retain: (owner) => {
        onTestFinished(async () => {
          expect((await owner.stop()).status).not.toBe("incomplete");
        });
      },
    }).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await ownershipPreparation.reached(pending, "native ownership preparation");
    // Observe before release; assert after the command is joined so a failed
    // check never leaves it running past the test.
    const armedWhilePreparing = commandDeadlines();
    ownershipPreparation.release();
    const result = await pending;
    // The command deadline is armed only once preparation has finished.
    expect(armedWhilePreparing).toEqual([]);
    if (!result.ok) throw result.error;
    expect(result.value.stdout.trim()).toBe(process.version);
    expect(commandDeadlines()).toHaveLength(1);
  },
);

it("returns complete stdout while retaining unresolved process cleanup", async () => {
  let retained:
    | {
        readonly resources: readonly string[];
        readonly reason: string;
        readonly owner: ProviderProcessSupervisor;
      }
    | undefined;
  let mayClean = false;
  const output = await runPcapCommand({
    platform: HOST_PLATFORM.platform,
    operation: "inspect_pcap_capture",
    command: process.execPath,
    arguments: ["-e", 'process.stdout.write("complete producer output")'],
    limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
    environment: {},
    signal: undefined,
    launcher: async (spawn) => {
      const launched = await spawnOwnedProviderProcess(spawn);
      const cleanup =
        launched.cleanup ??
        (() => cleanupOwnedProcessGroup(launched.ownership));
      return {
        ...launched,
        cleanup: async () => {
          const stopped = await cleanup();
          if (!mayClean) throw new Error("injected cleanup uncertainty");
          return stopped;
        },
      };
    },
    retain: (owner, resources, reason) => {
      retained = { owner, resources, reason };
    },
  });
  expect(output.stdout).toBe("complete producer output");
  expect(output.cleanup).toMatchObject({
    reason: "injected cleanup uncertainty",
    capturedOutput: {
      stdout: "complete producer output",
      stderr: "",
      truncated: false,
    },
  });
  expect(retained?.resources).toContain(
    `process-group:${retained?.owner.launch.ownership?.processGroupId}`,
  );
  expect(retained?.reason).toBe("injected cleanup uncertainty");
  if (retained === undefined) throw new Error("Cleanup owner was not retained");
  mayClean = true;
  expect((await retained.owner.stop()).status).not.toBe("incomplete");
});

it.each([
  ["EPERM", "exists but could not be executed"],
  ["EACCES", "exists but could not be executed"],
  ["ENOENT", "was not found"],
])(
  "reports a %s launch refusal while reading a capture as an unavailable tool",
  async (code, wording) => {
    const failure = await runPcapCommand({
      platform: HOST_PLATFORM.platform,
      operation: "inspect_pcap_capture",
      command: "/selected/tshark",
      arguments: ["-r", "/authored-capture.pcap"],
      inputPath: "/authored-capture.pcap",
      limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
      environment: {},
      signal: undefined,
      launcher: async () => {
        throw Object.assign(new Error(`spawn /selected/tshark ${code}`), {
          code,
          syscall: "spawn /selected/tshark",
          path: "/selected/tshark",
        });
      },
      retain: () => {
        throw new Error("No provider resources were acquired");
      },
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
      message: expect.stringContaining(`${wording} (${code})`),
    });
  },
);

posixIt(
  "names the selected tool on a launch refusal Node throws synchronously",
  async () => {
    // Node throws ENOTDIR synchronously with a bare `spawn` syscall rather
    // than emitting `spawn <path>`. A path through a regular file refuses
    // the same way on every POSIX host; ENOEXEC does not, because Linux
    // libc may retry a headerless file through /bin/sh.
    const directory = await createTestTempDirectory("rea-pcap-enotdir-");
    const file = join(directory, "not-a-directory");
    await writeFile(file, "");
    const command = join(file, "tshark");
    const failure = await runPcapCommand({
      platform: HOST_PLATFORM.platform,
      operation: "inspect_pcap_client",
      command,
      arguments: ["--version"],
      limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
      environment: {},
      signal: undefined,
      launcher: spawnOwnedProviderProcess,
      retain: () => {
        throw new Error("No provider resources were acquired");
      },
    }).catch((cause: unknown) => cause);
    expect(failure).toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
      message: expect.stringContaining("was not found (ENOTDIR)"),
    });
  },
);

it("reports the Windows native launcher's refusal of the selected tool as an unavailable tool", async () => {
  const command = "C:\\Wireshark\\tshark.exe";
  const failure = await runPcapCommand({
    platform: HOST_PLATFORM.platform,
    operation: "inspect_pcap_capture",
    command,
    arguments: ["-r", "/authored-capture.pcap"],
    inputPath: "/authored-capture.pcap",
    limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
    environment: {},
    signal: undefined,
    launcher: async () => {
      // The native addon names the refused executable without Node's
      // `syscall` and `path` fields.
      throw Object.assign(new Error("refused"), {
        code: "ENOENT",
        constraint: "Create process atomically inside owned Job Object failed",
        requestedPath: command,
        win32Code: 2,
      });
    },
    retain: () => {
      throw new Error("No provider resources were acquired");
    },
  }).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    message: expect.stringContaining("was not found (ENOENT)"),
  });
});

it("attributes a refused limiter spawn to the limiter, not Wireshark", async () => {
  const limiter = await selectArtifactCommandPath(process.execPath);
  const failure = await runPcapCommand({
    platform: HOST_PLATFORM.platform,
    operation: "inspect_pcap_capture",
    command: "/selected/tshark",
    arguments: [],
    inputPath: "/authored-capture.pcap",
    limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
    environment: {},
    signal: undefined,
    nativeBound: { limiter: { command: limiter, arguments: [] } },
    launcher: async () => {
      throw Object.assign(new Error("refused"), {
        code: "EPERM",
        syscall: `spawn ${limiter.invocationPath}`,
        path: limiter.invocationPath,
      });
    },
    retain: () => {
      throw new Error("No provider resources were acquired");
    },
  }).catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    message: expect.stringContaining(
      `capture limiter ${limiter.invocationPath}`,
    ),
    remediationAction: expect.stringContaining("REA_TSHARK_PRLIMIT_COMMAND"),
  });
});

/**
 * A stand-in for util-linux prlimit: it either refuses with prlimit's own
 * err(3) diagnostics or replaces itself with the selected tool.
 */
const prlimitStandIn = async () => {
  const root = await createTestTempDirectory("rea-pcap-prlimit-");
  const prlimit = join(root, "prlimit");
  await writeFile(
    prlimit,
    `#!/bin/sh
while [ "\${1#--}" != "$1" ]; do
  if [ "$1" = "--refuse" ]; then
    printf 'prlimit: failed to set the AS resource limit: Operation not permitted\\n' >&2; exit 1
  fi
  shift
done
if [ ! -e "$1" ]; then printf 'prlimit: failed to execute %s: No such file or directory\\n' "$1" >&2; exit 127; fi
if [ ! -x "$1" ]; then printf 'prlimit: failed to execute %s: Permission denied\\n' "$1" >&2; exit 126; fi
exec "$@"
`,
    { mode: 0o755 },
  );
  const capinfos = join(root, "capinfos");
  await writeFile(
    capinfos,
    "#!/bin/sh\nprintf 'capinfos: The file is not a capture file\\n' >&2; exit 1\n",
    { mode: 0o755 },
  );
  const notExecutable = join(root, "tshark-not-executable");
  await writeFile(notExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
  return {
    limiter: await selectArtifactCommandPath(prlimit),
    capinfos,
    notExecutable,
    missing: join(root, "missing-tshark"),
  };
};

const runLimited = async (
  limiter: Awaited<ReturnType<typeof prlimitStandIn>>["limiter"],
  command: string,
  limiterArguments: string[] = ["--as=1073741824"],
) =>
  runPcapCommand({
    platform: HOST_PLATFORM.platform,
    operation: "inspect_pcap_capture",
    command,
    arguments: [],
    inputPath: "/authored-capture.pcap",
    limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
    environment: {},
    signal: undefined,
    nativeBound: { limiter: { command: limiter, arguments: limiterArguments } },
    retain: (owner) =>
      onTestFinished(async () => {
        await owner.stop();
      }),
  }).catch((cause: unknown) => cause);

posixIt(
  "attributes a limited tool's own exit to the tool through prlimit",
  async () => {
    const { limiter, capinfos } = await prlimitStandIn();
    const failure = await runLimited(limiter, capinfos);
    expect(failure).toBeInstanceOf(AnalysisUnsupportedTargetError);
    expect(projectAnalysisError(failure as AnalysisError)).toMatchObject({
      code: "unsupported_target",
    });
  },
);

posixIt("attributes prlimit's failed exec to the selected tool", async () => {
  const { limiter, missing, notExecutable } = await prlimitStandIn();
  for (const [command, wording] of [
    [missing, "was not found"],
    [notExecutable, "exists but could not be executed"],
  ] as const) {
    const failure = await runLimited(limiter, command);
    expect(failure).toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
      message: expect.stringContaining(`Selected tool ${command} ${wording}`),
    });
    expect(failure).not.toMatchObject({
      remediationAction: expect.stringContaining("REA_TSHARK_PRLIMIT_COMMAND"),
    });
  }
});

posixIt("attributes prlimit's own refusal to the limiter", async () => {
  const { limiter, capinfos } = await prlimitStandIn();
  const failure = await runLimited(limiter, capinfos, ["--refuse"]);
  expect(failure).toMatchObject({
    _tag: "AnalysisCapabilityUnavailableError",
    message: expect.stringContaining(
      `capture limiter ${limiter.invocationPath} failed before starting`,
    ),
    remediationAction: expect.stringContaining("REA_TSHARK_PRLIMIT_COMMAND"),
  });
});

it("does not attribute an errno without spawn identity to the selected tool", async () => {
  const failure = await runPcapCommand({
    platform: HOST_PLATFORM.platform,
    operation: "inspect_pcap_client",
    command: "/selected/tshark",
    arguments: ["--version"],
    limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
    environment: {},
    signal: undefined,
    launcher: async () => {
      throw Object.assign(new Error("ownership setup denied"), {
        code: "EPERM",
      });
    },
    retain: () => {
      throw new Error("No provider resources were acquired");
    },
  }).catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(AnalysisProtocolError);
  if (!(failure instanceof AnalysisProtocolError)) throw failure;
  expect(failure.message).toContain("failing stage is unknown");
});

it.each([
  ["win32", "C:\\Windows\\System32\\cmd.exe", true],
  ["linux", "C:\\Tools\\tshark.cmd", false],
] as const)(
  "launches a batch tool through cmd.exe only for a Windows host (%s)",
  async (platform, expectedCommand, verbatim) => {
    const launches: {
      readonly command: string;
      readonly windowsVerbatimArguments: boolean | undefined;
    }[] = [];
    await runPcapCommand({
      platform,
      operation: "inspect_pcap_client",
      command: "C:\\Tools\\tshark.cmd",
      arguments: ["--version"],
      limits: { timeoutMs: 5000, maxOutputBytes: 1024 },
      environment: { SYSTEMROOT: "C:\\Windows" },
      signal: undefined,
      launcher: async (spawn) => {
        launches.push({
          command: spawn.command,
          windowsVerbatimArguments: spawn.windowsVerbatimArguments,
        });
        throw new Error("recorded launch");
      },
      retain: () => {
        throw new Error("No provider resources were acquired");
      },
    }).catch(() => undefined);
    expect(launches).toEqual([
      { command: expectedCommand, windowsVerbatimArguments: verbatim },
    ]);
  },
);
