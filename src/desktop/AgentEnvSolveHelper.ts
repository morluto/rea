import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { readBoundedControlLines } from "../process/BoundedControlLines.js";
import { cleanupOwnedProcessGroup } from "../process/ProcessOwnership.js";
import {
  ProviderProcessSupervisor,
  spawnOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import { SolveSandboxRoot } from "./SolveSandboxRoot.js";
import {
  AGENTENV_PROVIDER,
  agentEnvInterpreter,
  removeSandbox,
} from "./AgentEnvComputerHelper.js";

const HELPER = fileURLToPath(
  new URL("../../bridge/agentenv/solve.py", import.meta.url),
);
const REPORT_BYTES = 256 * 1024;
const STDERR_BYTES = 16 * 1024;
/** The longest one solve may take, its deploy and teardown included, before REA stops it. */
const SOLVE_MS = 45 * 60_000;
/** How long a stopped solve has to tear its computer down. */
const STOP_MS = 120_000;
const POLL_MS = 1_000;
/** How long REA waits for the report once the helper's process group is cleared. */
const REPORT_DRAIN_MS = 5_000;

const cleanupSchema = z.strictObject({
  unknown: z.boolean(),
  sandboxes: z.array(
    z.strictObject({ id: z.string().min(1), type: z.string().nullable() }),
  ),
});
const reportSchema = z.union([
  z.strictObject({
    outcome: z.enum([
      "passed",
      "scored below 1",
      "unscored",
      "failed",
      "cancelled",
    ]),
    instance_id: z.string().nullable(),
    seconds: z.number().nonnegative(),
    checks: z.array(
      z.strictObject({
        id: z.string(),
        passed: z.boolean(),
        description: z.string(),
      }),
    ),
    turns: z.int().nonnegative().nullable(),
    usd: z.number().nonnegative().nullable(),
    agentenv: z.string().nullable(),
    error: z.string().nullable(),
    cleanup: cleanupSchema.optional(),
  }),
  z.strictObject({ error: z.string(), cleanup: cleanupSchema.optional() }),
]);

/** What the helper printed: how the solve ended, or why no solve ran. */
export type SolveReport = z.infer<typeof reportSchema>;
export type SolveCleanupOwner = Pick<
  ProviderProcessSupervisor,
  "stop" | "dispose"
>;

/** Failed cleanup retains both its owner and any report the helper completed. */
export class SolveCleanupError extends ProviderCleanupError {
  constructor(
    readonly report: SolveReport | undefined,
    resources: readonly string[],
    diagnostics: Readonly<
      Record<string, import("../domain/jsonValue.js").JsonValue>
    >,
    operation: string,
    unknown = false,
  ) {
    super(
      AGENTENV_PROVIDER,
      resources,
      {
        ...diagnostics,
        ...(report === undefined
          ? {}
          : { solve_report: jsonValueSchema.parse(report) }),
      },
      {
        operation,
        remediationAction: unknown
          ? "REA could not verify cleanup of every sandbox under this solve's private root. Closing REA retries cleanup of the retained root; inspect its agentenv records and Docker containers for anything still running."
          : "Closing REA retries this cleanup; check that no agentenv run of the bundle is still up with docker ps.",
      },
    );
  }
}

/** A completed report remains available when cancellation arrives during teardown. */
export class SolveCancelledError extends AnalysisCancelledError {
  constructor(
    readonly report: SolveReport,
    operation: string,
    reason: unknown,
  ) {
    super(operation, {
      cause: reason,
      diagnostics: { solve_report: jsonValueSchema.parse(report) },
    });
  }
}

const parseReport = (line: string): SolveReport => {
  try {
    const parsed = reportSchema.safeParse(JSON.parse(line));
    if (parsed.success) return parsed.data;
  } catch {
    // Reported below as a line that is not a report.
  }
  return {
    error: "REA's solve helper wrote something other than its report",
    cleanup: { unknown: true, sandboxes: [] },
  };
};

/** How long a solve may run, and how long a stopped one has to exit before its process group is cleared. */
interface SolveTiming {
  readonly solveMs: number;
  readonly stopMs: number;
}

/**
 * One solve of a bundle's task in a fresh computer, through REA's helper run
 * with the agentenv runner's Python; the solver's model endpoint is the one
 * agentenv reads from the environment or its config. Cancelling it stops the
 * helper, which tears its computer down, and a helper still running after
 * the stop grace has its process group cleared. A helper whose cleanup could
 * not be confirmed goes to `retainCleanup`, so closing REA can retry it.
 */
export const runSolveHelper = async (options: {
  readonly bundle: string;
  readonly task: string;
  readonly model: string;
  readonly agent: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly signal: AbortSignal;
  readonly operation: string;
  readonly retainCleanup: (owner: SolveCleanupOwner) => void;
  readonly spawn?: typeof spawnOwnedProviderProcess;
  readonly timing?: SolveTiming;
}): Promise<SolveReport> => {
  const { environment, signal } = options;
  const timing = options.timing ?? { solveMs: SOLVE_MS, stopMs: STOP_MS };
  const interpreter = await agentEnvInterpreter(environment, options.operation);
  const sandboxRoot = await SolveSandboxRoot.create(interpreter, environment);
  let spawned: Awaited<ReturnType<typeof spawnOwnedProviderProcess>>;
  try {
    spawned = await (options.spawn ?? spawnOwnedProviderProcess)({
      command: interpreter,
      arguments: [
        HELPER,
        options.bundle,
        options.task,
        options.model,
        options.agent,
      ],
      runId: randomUUID(),
      expectedCommand: null,
      hostEnvironment: environment,
      env: {
        PYTHONDONTWRITEBYTECODE: "1",
        AGENT_ENV_LOCAL_SANDBOX_DIR: sandboxRoot.path,
      },
      signal,
    });
  } catch (cause: unknown) {
    const cleanup = await sandboxRoot.stop();
    if (cleanup.status === "incomplete") {
      const failure = new SolveCleanupError(
        undefined,
        [`sandbox root ${sandboxRoot.path}`],
        {
          reason: cleanup.reason,
          spawn_error: cause instanceof Error ? cause.message : String(cause),
        },
        options.operation,
      );
      failure.bindCleanupResourceOwner({
        get cleanupResources() {
          return sandboxRoot.removed
            ? []
            : [`sandbox root ${sandboxRoot.path}`];
        },
      });
      options.retainCleanup({
        async stop() {
          const result = await sandboxRoot.stop();
          if (result.status === "verified-cleanup") failure.resolveCleanup();
          return result;
        },
        dispose: () => sandboxRoot.dispose(),
      });
      throw failure;
    }
    throw cause;
  }
  const supervisor = new ProviderProcessSupervisor(
    {
      ...spawned,
      ownsProcessLifetime: true,
      cleanup:
        spawned.cleanup ?? (() => cleanupOwnedProcessGroup(spawned.ownership)),
    },
    {
      captureStdout: false,
      maxDiagnosticBytes: { stdout: 0, stderr: STDERR_BYTES },
      diagnosticRetention: "tail",
    },
  );
  let report: SolveReport | undefined;
  const reading = (async () => {
    const stdout = spawned.process.stdout;
    if (stdout === null) return;
    for await (const line of readBoundedControlLines(stdout, REPORT_BYTES))
      report ??= line.ok
        ? parseReport(line.value)
        : {
            error: "REA's solve helper's report is too long",
            cleanup: { unknown: true, sandboxes: [] },
          };
  })().catch(() => undefined);
  let stopped: Awaited<ReturnType<ProviderProcessSupervisor["stop"]>>;
  const begun = Date.now();
  try {
    const deadline = begun + timing.solveMs;
    while (
      !signal.aborted &&
      Date.now() < deadline &&
      !(await supervisor.waitForExit(POLL_MS))
    );
    if (supervisor.observedExit() === undefined) {
      spawned.process.kill("SIGTERM");
      await supervisor.waitForExit(timing.stopMs);
    }
  } finally {
    // Clearing the process group closes stdout, so the report is read only after it, and only so long.
    stopped = await supervisor.stop();
    await Promise.race([
      reading,
      new Promise((resolve) => setTimeout(resolve, REPORT_DRAIN_MS)),
    ]);
  }
  let processPending = stopped.status === "incomplete";
  const pending = new Map(
    (report?.cleanup?.sandboxes ?? []).map((item) => [item.id, item.type]),
  );
  let unknown = report?.cleanup?.unknown ?? true;
  const resources = () => [
    ...(processPending
      ? [`process group ${String(spawned.ownership.processGroupId)}`]
      : []),
    ...[...pending.keys()].map((id) => `agentenv sandbox ${id}`),
    ...(!sandboxRoot.removed ? [`sandbox root ${sandboxRoot.path}`] : []),
    ...(unknown ? ["agentenv sandbox identity unknown"] : []),
  ];
  let cleanupError: SolveCleanupError | undefined;
  const cleanupOwner: SolveCleanupOwner = {
    async stop() {
      if (processPending) {
        const result = await supervisor.stop();
        if (result.status === "incomplete") return result;
        processPending = false;
      }
      const failures: string[] = [];
      for (const [id, type] of pending) {
        if (type !== null && type !== "local") {
          failures.push(`Sandbox ${id} uses unsupported provider ${type}.`);
          continue;
        }
        const failure = await removeSandbox(environment, id);
        if (failure === undefined) pending.delete(id);
        else failures.push(failure);
      }
      const rootCleanup = await sandboxRoot.stop();
      if (rootCleanup.status === "incomplete")
        failures.push(rootCleanup.reason);
      if (failures.length > 0)
        return { status: "incomplete", reason: failures.join(" ") };
      // The solve's sandboxes are all local under its private root, and agentenv keeps a sandbox's folder until its teardown is confirmed, so an emptied root leaves none up.
      if (sandboxRoot.removed) unknown = false;
      if (!unknown) cleanupError?.resolveCleanup();
      return { status: "verified-cleanup" };
    },
    dispose: () => {
      supervisor.dispose();
      sandboxRoot.dispose();
    },
  };
  const cleanup = processPending ? stopped : await cleanupOwner.stop();
  if (cleanup.status === "incomplete" || unknown) {
    if (cleanup.status === "incomplete") options.retainCleanup(cleanupOwner);
    const reason =
      cleanup.status === "incomplete"
        ? cleanup.reason
        : "The helper ended before identifying every sandbox, and REA could not empty its sandbox root.";
    cleanupError = new SolveCleanupError(
      report,
      resources(),
      {
        reason,
        leader_pid: spawned.ownership.leaderPid,
        process_group_id: spawned.ownership.processGroupId,
        helper_stderr: supervisor.snapshot().stderr.text,
      },
      options.operation,
      unknown,
    );
    cleanupError.bindCleanupResourceOwner({
      get cleanupResources() {
        return resources();
      },
    });
    throw cleanupError;
  }
  if (signal.aborted && report !== undefined)
    throw new SolveCancelledError(report, options.operation, signal.reason);
  signal.throwIfAborted();
  if (report !== undefined) return report;
  const exit = supervisor.observedExit();
  const stderr = supervisor.snapshot().stderr.text.slice(-2000);
  // A helper a signal ended, REA's deadline or an outside kill, was stopped mid-solve; one that exited without a report never ran one.
  if (exit?.signal != null)
    return {
      outcome: "failed",
      instance_id: null,
      seconds: (Date.now() - begun) / 1000,
      checks: [],
      turns: null,
      usd: null,
      agentenv: null,
      error: `REA's solve helper was stopped (${exit.signal}) without a report: ${stderr}`,
      cleanup: { unknown, sandboxes: [] },
    };
  return {
    error: `REA's solve helper ended (exit ${String(exit?.code)}) without a report: ${stderr}`,
    cleanup: { unknown, sandboxes: [] },
  };
};
