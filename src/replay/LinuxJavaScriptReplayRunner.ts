import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  JavaScriptReplayPolicy,
  JavaScriptReplayRunner,
  PreparedReplayPlan,
} from "../application/JavaScriptReplayPlanning.js";
import {
  digestBytes,
  digestJson,
} from "../application/JavaScriptReplayPlanning.js";
import type { ReplayExecutionResult } from "../domain/javascriptReplay.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import {
  buildLinuxX64ReplaySeccomp,
  linuxX64ReplaySeccompDigest,
} from "./LinuxSeccompPolicy.js";
import { resolveLinuxRuntimeClosure } from "./LinuxRuntimeClosure.js";
import {
  parseReplayWorkerResponse,
  type WorkerProtocolOutcome,
  type WorkerProtocolResponse,
} from "./ReplayWorkerProtocol.js";

const isAborted = (signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true;

/** Run one prepared experiment under the exact Linux ADR-0002 boundary. */
export class LinuxJavaScriptReplayRunner implements JavaScriptReplayRunner {
  async execute(
    prepared: PreparedReplayPlan,
    policy: JavaScriptReplayPolicy,
    signal?: AbortSignal,
  ): Promise<ReplayExecutionResult> {
    if (isAborted(signal))
      return terminationResult(prepared, "", "cancelled", {
        state: "complete",
        residual_resources: [],
      });
    const unit = `rea-replay-${randomBytes(8).toString("hex")}.service`;
    const workerPath = prepared.publicPlan.runtime.worker.path;
    const closure = await resolveLinuxRuntimeClosure(policy.nodePath);
    assertRuntimeCommitment(prepared, closure);
    if (
      digestBytes(await readFile(workerPath)) !==
      prepared.publicPlan.runtime.worker.sha256
    )
      throw new TypeError("Replay worker changed after approval");
    if (
      linuxX64ReplaySeccompDigest() !==
      prepared.publicPlan.sandbox.seccomp_sha256
    )
      throw new TypeError("Replay seccomp policy changed after approval");
    const request = workerRequest(prepared);
    const encoded = Buffer.from(JSON.stringify(request));
    if (encoded.byteLength > prepared.publicPlan.limits.protocol_bytes)
      throw new RangeError(
        "Replay worker protocol input exceeds the committed limit",
      );
    const filter = await temporaryFilterHandle();
    const arguments_ = systemdArguments(
      unit,
      policy,
      prepared,
      workerPath,
      closure,
      filter.path,
    );
    let child: ReturnType<typeof spawn> | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let cancelled = false;
    let timedOut = false;
    let terminationRequest: Promise<void> | undefined;
    const requestTermination = (): void => {
      terminationRequest ??= killUnit(policy.systemctlPath, unit);
      child?.kill("SIGKILL");
    };
    const terminate = (): void => {
      cancelled = true;
      requestTermination();
    };
    try {
      const completion = new Promise<CollectedProcess>((resolve, reject) => {
        child = spawn(policy.systemdRunPath, arguments_, {
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: "/usr/bin:/bin",
            LANG: "C",
            LC_ALL: "C",
            TZ: "UTC",
            ...(process.env.XDG_RUNTIME_DIR === undefined
              ? {}
              : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),
            ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined
              ? {}
              : {
                  DBUS_SESSION_BUS_ADDRESS:
                    process.env.DBUS_SESSION_BUS_ADDRESS,
                }),
          },
        });
        const output = boundedCollector(
          prepared.publicPlan.limits.output_bytes,
        );
        const diagnostics = boundedCollector(
          prepared.publicPlan.limits.stderr_bytes,
        );
        child.stdout?.on("data", output.append);
        child.stderr?.on("data", diagnostics.append);
        child.once("error", reject);
        child.once("close", (code, signalName) =>
          resolve({
            code,
            signal: signalName,
            stdout: output.value(),
            stderr: diagnostics.value(),
            outputExceeded: output.exceeded(),
          }),
        );
        child.stdin?.end(encoded);
      });
      signal?.addEventListener("abort", terminate, { once: true });
      if (isAborted(signal)) terminate();
      timeout = setTimeout(() => {
        timedOut = true;
        requestTermination();
      }, prepared.publicPlan.limits.wall_time_ms);
      timeout.unref();
      const collected = await completion;
      if (terminationRequest !== undefined) await terminationRequest;
      const unitResult = await observeUnitResult(policy.systemctlPath, unit);
      const cleanup = await observeCleanup(policy.systemctlPath, unit);
      if (cancelled || timedOut)
        return terminationResult(
          prepared,
          collected.stderr,
          cancelled ? "cancelled" : "timeout",
          cleanup,
        );
      if (collected.outputExceeded)
        return terminationResult(
          prepared,
          collected.stderr,
          "protocol_error",
          cleanup,
          "Worker stdout exceeded the committed bound",
        );
      if (collected.code !== 0)
        return terminationResult(
          prepared,
          collected.stderr,
          collected.code === 137 || unitResult === "oom-kill" ? "oom" : "crash",
          cleanup,
        );
      let response: WorkerProtocolResponse;
      try {
        response = parseReplayWorkerResponse(
          JSON.parse(collected.stdout),
          prepared.publicPlan.cases,
          prepared.publicPlan.right !== undefined,
        );
      } catch {
        return terminationResult(
          prepared,
          collected.stderr,
          "protocol_error",
          cleanup,
        );
      }
      const outcomes = commitOutcomes(response.left);
      const right =
        response.right === undefined
          ? undefined
          : commitOutcomes(response.right);
      return {
        schema_version: 1,
        plan_digest: prepared.publicPlan.plan_digest,
        outcomes: [...outcomes, ...(right ?? [])],
        ...(right === undefined
          ? {}
          : { comparison: compareOutcomes(outcomes, right) }),
        stderr: collected.stderr,
        termination: "completed",
        cleanup,
        limitations: [
          "Controlled replay observes the isolated extracted modules, not the original application runtime.",
          "Network and host filesystem access were unavailable; unsupported dependencies may change behavior.",
        ],
        reproducer: null,
      };
    } finally {
      signal?.removeEventListener("abort", terminate);
      if (timeout !== undefined) clearTimeout(timeout);
      if (child !== undefined && child.exitCode === null) {
        requestTermination();
        await terminationRequest;
      }
      await filter.close();
    }
  }
}

const workerRequest = (prepared: PreparedReplayPlan) => ({
  schemaVersion: 1,
  left: workerSide(prepared.publicPlan.left, prepared.leftSources),
  ...(prepared.publicPlan.right === undefined ||
  prepared.rightSources === undefined
    ? {}
    : { right: workerSide(prepared.publicPlan.right, prepared.rightSources) }),
  cases: prepared.publicPlan.cases.map((item) => ({
    caseId: item.case_id,
    arguments: item.arguments,
    inputSha256: item.sha256,
  })),
  determinism: {
    clockIso: prepared.publicPlan.determinism.clock_iso,
    randomSeed: prepared.publicPlan.determinism.random_seed,
  },
  limits: {
    resultDepth: prepared.publicPlan.limits.result_depth,
    resultNodes: prepared.publicPlan.limits.result_nodes,
    exceptionBytes: Math.min(
      64 * 1024,
      prepared.publicPlan.limits.output_bytes,
    ),
  },
});

const workerSide = (
  side: PreparedReplayPlan["publicPlan"]["left"],
  sources: Readonly<Record<string, string>>,
) => ({
  modules: side.modules.map((module) => ({
    alias: module.alias,
    format: module.format,
    dependencies: module.dependencies,
    source: sources[module.alias] ?? "",
  })),
  entryAlias: side.entry_alias,
  entryExport: side.entry_export,
});

const systemdArguments = (
  unit: string,
  policy: JavaScriptReplayPolicy,
  prepared: PreparedReplayPlan,
  workerPath: string,
  closure: readonly RuntimeFile[],
  filterPath: string,
): string[] => {
  const limits = prepared.publicPlan.limits;
  const descriptorPaths = [
    filterPath,
    ...closure.map(({ sourcePath }) => sourcePath),
    workerPath,
  ];
  const workerFd = descriptorPaths.length + 2;
  const wrapper = descriptorPaths
    .map((_, index) => `exec ${String(index + 3)}<"$1"; shift`)
    .concat('exec "$@"')
    .join("\n");
  return [
    "--user",
    "--pipe",
    "--wait",
    "--service-type=exec",
    "--quiet",
    `--unit=${unit}`,
    `--property=MemoryMax=${String(limits.memory_bytes)}`,
    "--property=MemorySwapMax=0",
    `--property=TasksMax=${String(limits.tasks)}`,
    `--property=CPUQuota=${String(limits.cpu_quota_percent)}%`,
    "--property=KillMode=control-group",
    "--property=SendSIGKILL=yes",
    "--",
    policy.shellPath,
    "-c",
    wrapper,
    "rea-replay-wrapper",
    ...descriptorPaths,
    policy.bubblewrapPath,
    "--unshare-all",
    "--unshare-user",
    "--disable-userns",
    "--new-session",
    "--die-with-parent",
    "--cap-drop",
    "ALL",
    "--clearenv",
    "--setenv",
    "HOME",
    "/work",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "TZ",
    "UTC",
    "--setenv",
    "LANG",
    "C",
    "--setenv",
    "LC_ALL",
    "C",
    "--tmpfs",
    "/",
    "--dir",
    "/runtime",
    "--dir",
    "/work",
    "--size",
    String(limits.tmpfs_bytes),
    "--tmpfs",
    "/tmp",
    ...bindArguments(closure),
    "--ro-bind-fd",
    String(workerFd),
    "/runtime/worker.js",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--remount-ro",
    "/",
    "--chdir",
    "/work",
    "--seccomp",
    "3",
    "--",
    "/runtime/node",
    `--max-old-space-size=${String(Math.max(8, Math.floor(limits.memory_bytes / 1024 / 1024 / 2)))}`,
    "--experimental-vm-modules",
    "--permission",
    "--allow-fs-read=/runtime/worker.js",
    "/runtime/worker.js",
  ];
};

const bindArguments = (closure: readonly RuntimeFile[]): string[] => {
  const arguments_: string[] = [];
  const directories = new Set<string>();
  for (const [index, item] of closure.entries()) {
    const destination = item.destinationPath;
    let parent = dirname(destination);
    const chain: string[] = [];
    while (parent !== "/" && !directories.has(parent)) {
      chain.push(parent);
      parent = dirname(parent);
    }
    for (const directory of chain.reverse()) {
      directories.add(directory);
      arguments_.push("--dir", directory);
    }
    arguments_.push("--ro-bind-fd", String(index + 4), destination);
  }
  return arguments_;
};

type RuntimeFile = Awaited<
  ReturnType<typeof resolveLinuxRuntimeClosure>
>[number];

const assertRuntimeCommitment = (
  prepared: PreparedReplayPlan,
  closure: readonly RuntimeFile[],
): void => {
  const observed = closure.map((item) => ({
    source_path: item.sourcePath,
    destination_path: item.destinationPath,
    sha256: item.sha256,
  }));
  if (
    digestJson(observed) !==
    digestJson(prepared.publicPlan.runtime.read_only_files)
  )
    throw new TypeError("Replay runtime closure changed after approval");
};

const temporaryFilterHandle = async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "rea-replay-filter-"));
  const path = join(directory, "seccomp.bpf");
  await writeFile(path, buildLinuxX64ReplaySeccomp(), { mode: 0o600 });
  const handle = await open(path, "r");
  return {
    path,
    handle,
    close: async () => {
      await handle.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
};

interface CollectedProcess {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputExceeded: boolean;
}

const boundedCollector = (maximum: number) => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflow = false;
  return {
    append: (chunk: Buffer) => {
      const retained = chunk.subarray(0, Math.max(0, maximum - bytes));
      if (retained.byteLength > 0) chunks.push(retained);
      bytes += retained.byteLength;
      if (retained.byteLength < chunk.byteLength) overflow = true;
    },
    value: () => Buffer.concat(chunks).toString("utf8"),
    exceeded: () => overflow,
  };
};

const collect = async (
  executable: string,
  arguments_: readonly string[],
  maximum: number,
) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(executable, [...arguments_], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = boundedCollector(maximum);
      const stderr = boundedCollector(maximum);
      const timeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      timeout.unref();
      child.stdout?.on("data", stdout.append);
      child.stderr?.on("data", stderr.append);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve({ code, stdout: stdout.value(), stderr: stderr.value() });
      });
    },
  );

const killUnit = async (systemctl: string, unit: string): Promise<void> => {
  try {
    await collect(
      systemctl,
      ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit],
      4096,
    );
  } catch {
    /* cleanup continues */
  }
};

const observeCleanup = async (
  systemctl: string,
  unit: string,
): Promise<ReplayExecutionResult["cleanup"]> => {
  try {
    const state = await collect(
      systemctl,
      ["--user", "show", "--property=ActiveState", "--value", unit],
      4096,
    );
    if (
      state.code !== 0 ||
      state.stdout.trim() === "inactive" ||
      state.stdout.trim() === "failed" ||
      state.stdout.trim().length === 0
    ) {
      await collect(systemctl, ["--user", "reset-failed", unit], 4096);
      return { state: "complete", residual_resources: [] };
    }
    return { state: "incomplete", residual_resources: [unit] };
  } catch {
    return { state: "incomplete", residual_resources: [unit] };
  }
};

const observeUnitResult = async (
  systemctl: string,
  unit: string,
): Promise<string> => {
  try {
    const result = await collect(
      systemctl,
      ["--user", "show", "--property=Result", "--value", unit],
      4096,
    );
    return result.stdout.trim();
  } catch {
    return "unknown";
  }
};

const commitOutcomes = (
  outcomes: readonly WorkerProtocolOutcome[],
): ReplayExecutionResult["outcomes"] =>
  outcomes.map((outcome) => {
    const semantic =
      outcome.value === undefined ? (outcome.exception ?? null) : outcome.value;
    return {
      case_id: outcome.case_id,
      outcome: outcome.outcome,
      ...(outcome.value === undefined
        ? {}
        : { value: jsonValueSchema.parse(outcome.value) }),
      ...(outcome.exception === undefined
        ? {}
        : { exception: outcome.exception }),
      input_sha256: outcome.input_sha256,
      output_sha256: digestJson(semantic),
      truncated: false,
    };
  });

const compareOutcomes = (
  left: ReplayExecutionResult["outcomes"],
  right: ReplayExecutionResult["outcomes"],
): NonNullable<ReplayExecutionResult["comparison"]> =>
  left.map((item, index) => ({
    case_id: item.case_id,
    status:
      right[index] === undefined
        ? "unknown"
        : item.outcome === right[index].outcome &&
            item.output_sha256 === right[index].output_sha256
          ? "equal"
          : "changed",
    left_index: index,
    right_index: index,
  }));

const terminationResult = (
  prepared: PreparedReplayPlan,
  stderr: string,
  termination: "timeout" | "oom" | "crash" | "cancelled" | "protocol_error",
  cleanup: ReplayExecutionResult["cleanup"],
  limitation?: string,
): ReplayExecutionResult => {
  const outcomes = prepared.publicPlan.cases.map((item) => ({
    case_id: item.case_id,
    outcome: termination,
    input_sha256: item.sha256,
    output_sha256: null,
    truncated: termination === "protocol_error",
  }));
  const differential = prepared.publicPlan.right !== undefined;
  return {
    schema_version: 1,
    plan_digest: prepared.publicPlan.plan_digest,
    outcomes: [...outcomes, ...(differential ? outcomes : [])],
    ...(differential
      ? {
          comparison: outcomes.map((item, index) => ({
            case_id: item.case_id,
            status: "unknown" as const,
            left_index: index,
            right_index: index,
          })),
        }
      : {}),
    stderr,
    termination,
    cleanup,
    limitations: [
      limitation ??
        `Replay terminated with ${termination}; the requested functional result remains unknown.`,
    ],
    reproducer: null,
  };
};
