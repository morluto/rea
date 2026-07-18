import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  digestBytes,
  type JavaScriptReplayPolicy,
  type JavaScriptReplayRunner,
  type PreparedReplayPlan,
} from "../application/JavaScriptReplayPlanning.js";
import type { ReplayExecutionResult } from "../domain/javascriptReplay.js";
import { linuxX64ReplaySeccompDigest } from "./LinuxSeccompPolicy.js";
import { resolveLinuxRuntimeClosure } from "./LinuxRuntimeClosure.js";
import {
  assertRuntimeCommitment,
  systemdArguments,
  temporaryFilterHandle,
  type RuntimeFile,
} from "./LinuxJavaScriptReplaySandbox.js";
import {
  boundedCollector,
  killUnit,
  observeCleanup,
  observeUnitResult,
  type CollectedProcess,
} from "./ReplayProcessLifecycle.js";
import {
  commitOutcomes,
  compareOutcomes,
  terminationResult,
  workerRequest,
} from "./ReplayOutcome.js";
import {
  parseReplayWorkerResponse,
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
      return terminationResult({
        prepared,
        stderr: "",
        termination: "cancelled",
        cleanup: { state: "complete", residual_resources: [] },
      });
    const unit = `rea-replay-${randomBytes(8).toString("hex")}.service`;
    const closure = await validateReplayCommitments(prepared, policy);
    const encoded = buildWorkerPayload(prepared);
    const filter = await temporaryFilterHandle();
    const replayProcess = launchReplayProcess({
      prepared,
      policy,
      encoded,
      closure,
      filterPath: filter.path,
      unit,
      signal,
    });
    try {
      const collected = await replayProcess.completion;
      if (replayProcess.terminationRequest !== undefined)
        await replayProcess.terminationRequest;
      const unitResult = await observeUnitResult(policy.systemctlPath, unit);
      const cleanup = await observeCleanup(policy.systemctlPath, unit);
      return resolveReplayResult({
        prepared,
        collected,
        unitResult,
        cleanup,
        cancelled: replayProcess.cancelled,
        timedOut: replayProcess.timedOut,
      });
    } finally {
      signal?.removeEventListener("abort", replayProcess.terminate);
      if (replayProcess.timeout !== undefined)
        clearTimeout(replayProcess.timeout);
      if (
        replayProcess.child !== undefined &&
        replayProcess.child.exitCode === null
      ) {
        replayProcess.requestTermination();
        await replayProcess.terminationRequest;
      }
      await filter.close();
    }
  }
}

const validateReplayCommitments = async (
  prepared: PreparedReplayPlan,
  policy: JavaScriptReplayPolicy,
): Promise<readonly RuntimeFile[]> => {
  const closure = await resolveLinuxRuntimeClosure(policy.nodePath);
  assertRuntimeCommitment(prepared, closure);
  const workerPath = prepared.publicPlan.runtime.worker.path;
  if (
    digestBytes(await readFile(workerPath)) !==
    prepared.publicPlan.runtime.worker.sha256
  )
    throw new TypeError("Replay worker changed after approval");
  if (
    linuxX64ReplaySeccompDigest() !== prepared.publicPlan.sandbox.seccomp_sha256
  )
    throw new TypeError("Replay seccomp policy changed after approval");
  return closure;
};

const buildWorkerPayload = (prepared: PreparedReplayPlan): Buffer => {
  const request = workerRequest(prepared);
  const encoded = Buffer.from(JSON.stringify(request));
  if (encoded.byteLength > prepared.publicPlan.limits.protocol_bytes)
    throw new RangeError(
      "Replay worker protocol input exceeds the committed limit",
    );
  return encoded;
};

interface LaunchReplayProcessOptions {
  readonly prepared: PreparedReplayPlan;
  readonly policy: JavaScriptReplayPolicy;
  readonly encoded: Buffer;
  readonly closure: readonly RuntimeFile[];
  readonly filterPath: string;
  readonly unit: string;
  readonly signal: AbortSignal | undefined;
}

interface ReplayProcess {
  readonly child: ReturnType<typeof spawn>;
  readonly completion: Promise<CollectedProcess>;
  readonly timeout: NodeJS.Timeout;
  readonly terminate: () => void;
  readonly requestTermination: () => void;
  readonly terminationRequest: Promise<void> | undefined;
  readonly cancelled: boolean;
  readonly timedOut: boolean;
}

const launchReplayProcess = (
  options: LaunchReplayProcessOptions,
): ReplayProcess => {
  const { prepared, policy, encoded, closure, filterPath, unit, signal } =
    options;
  const arguments_ = systemdArguments({
    unit,
    policy,
    prepared,
    workerPath: prepared.publicPlan.runtime.worker.path,
    closure,
    filterPath,
  });
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
  const completion = new Promise<CollectedProcess>((resolve, reject) => {
    child = spawn(policy.systemdRunPath, arguments_, {
      stdio: ["pipe", "pipe", "pipe"],
      env: replayProcessEnvironment(),
    });
    const output = boundedCollector(prepared.publicPlan.limits.output_bytes);
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
  if (child === undefined || timeout === undefined)
    throw new TypeError("Replay process was not launched");
  return {
    child,
    completion,
    timeout,
    terminate,
    requestTermination,
    get terminationRequest() {
      return terminationRequest;
    },
    get cancelled() {
      return cancelled;
    },
    get timedOut() {
      return timedOut;
    },
  };
};

const replayProcessEnvironment = (): NodeJS.ProcessEnv => ({
  PATH: "/usr/bin:/bin",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  ...(process.env.XDG_RUNTIME_DIR === undefined
    ? {}
    : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),
  ...(process.env.DBUS_SESSION_BUS_ADDRESS === undefined
    ? {}
    : { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }),
});

interface ResolveReplayResultOptions {
  readonly prepared: PreparedReplayPlan;
  readonly collected: CollectedProcess;
  readonly unitResult: string;
  readonly cleanup: ReplayExecutionResult["cleanup"];
  readonly cancelled: boolean;
  readonly timedOut: boolean;
}

const resolveReplayResult = (
  options: ResolveReplayResultOptions,
): ReplayExecutionResult => {
  const { prepared, collected, unitResult, cleanup, cancelled, timedOut } =
    options;
  if (cancelled || timedOut)
    return terminationResult({
      prepared,
      stderr: collected.stderr,
      termination: cancelled ? "cancelled" : "timeout",
      cleanup,
    });
  if (collected.outputExceeded)
    return terminationResult({
      prepared,
      stderr: collected.stderr,
      termination: "protocol_error",
      cleanup,
      limitation: "Worker stdout exceeded the committed bound",
    });
  if (collected.code !== 0)
    return terminationResult({
      prepared,
      stderr: collected.stderr,
      termination:
        collected.code === 137 || unitResult === "oom-kill" ? "oom" : "crash",
      cleanup,
    });
  let response: WorkerProtocolResponse;
  try {
    const rawResponse: unknown = JSON.parse(collected.stdout);
    response = parseReplayWorkerResponse(
      rawResponse,
      prepared.publicPlan.cases,
      prepared.publicPlan.right !== undefined,
    );
  } catch {
    return terminationResult({
      prepared,
      stderr: collected.stderr,
      termination: "protocol_error",
      cleanup,
    });
  }
  const outcomes = commitOutcomes(response.left);
  const right =
    response.right === undefined ? undefined : commitOutcomes(response.right);
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
};
