import {
  parsePortableBundleName,
  PORTABLE_BUNDLE_NAME_CONSTRAINT,
} from "../../domain/portableBundleName.js";
import { createHash } from "node:crypto";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  ArtifactFileCleanupFailure,
  bindArtifactFileCleanup,
} from "../../artifacts/ArtifactFileOperation.js";
import { RegularFileCapacityError } from "../../filesystem/readStableFileBytes.js";
import {
  guestFileAnswerCeiling,
  guestFileAnswerWorkingBytes,
} from "../../desktop/AgentEnvComputer.js";
import { writeTextFile } from "../JsonFiles.js";
import { join, resolve } from "node:path";

import { z } from "zod";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import {
  difficultyRecord,
  difficultySection,
  nextSolve,
  withDifficultySection,
  type DifficultyRecord,
  type SolveRecord,
  type StopReason,
} from "../../domain/desktop/taskDifficulty.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok, type Result } from "../../domain/result.js";
import { safeParseUtf8Json } from "../../domain/safeJson.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import {
  runSolveHelper,
  SolveCleanupError,
  SolveCancelledError,
  type SolveReport,
  type SolveCleanupOwner,
} from "../../desktop/AgentEnvSolveHelper.js";
import {
  resolveBuildComputerEnvironment,
  type BuildComputerDefaults,
} from "../../desktop/BuildComputerEnvironment.js";
import { readHostFile } from "../../desktop/HostFileRead.js";
import { PRODUCT_IDENTITY } from "../../identity.js";
import {
  silentProgressReporter,
  type ProgressReporter,
} from "../ProgressReporter.js";
import { errorText } from "./DesktopBuildCommands.js";

const MEASURE = "measure_build_task";
/** The file at the bundle's root that records each measured task. */
const DIFFICULTY_FILE = "difficulty.json";
const README_FILE = "README.md";
/** The most bytes REA reads of a task's steps, verifier, README or difficulty file. */
const FILE_BYTES = 4 * 1024 * 1024;

/** What the agent asks the measure for. */
export interface MeasureRequest {
  readonly bundle: string;
  readonly task: string;
  readonly model: string;
  readonly agent: string;
  readonly budget_usd: number;
}

/** One solve of the task in a fresh computer. */
export type Solver = (
  request: Pick<MeasureRequest, "bundle" | "task" | "model" | "agent">,
  signal: AbortSignal,
) => Promise<SolveReport>;

/** What the measure reports: the record it wrote and where. */
export type MeasuredTask = Omit<DifficultyRecord, "solves" | "versions"> & {
  readonly bundle: string;
  readonly task: string;
  readonly solves: DifficultyRecord["solves"];
  readonly difficulty_file: string;
};

const refused = (userMessage: string, remediationAction: string) =>
  new AnalysisInputError(MEASURE, {
    userMessage,
    remediationAction,
    conformsToInputContract: true,
  });

/** Refuse malformed lookup identity before reading files or resolving a solver. */
const admitTaskName = (name: string): Result<string, AnalysisError> => {
  const parsed = parsePortableBundleName(name);
  if (parsed.ok) return parsed;
  const message = `Task ${JSON.stringify(name)} must be ${PORTABLE_BUNDLE_NAME_CONSTRAINT}.`;
  return err(
    new AnalysisInputError(
      MEASURE,
      {
        userMessage: message,
        remediationAction:
          "Select the exact portable task name written under the bundle's tasks directory.",
      },
      [{ path: ["task"], reason: "invalid_value", message }],
    ),
  );
};

/** The records a difficulty file holds, each read only as far as the README names it. */
const recordsSchema = z.looseObject({
  tasks: z.record(
    z.string(),
    z.looseObject({
      model: z.string(),
      passes: z.int(),
      k: z.int(),
      band: z.enum(["in_band", "too_easy", "too_hard", "undecided"]),
      usd: z.number(),
    }),
  ),
});

/** The task's steps and verifier as the export wrote them, digested, or why the bundle has none. */
const taskDigest = async (
  bundle: string,
  task: string,
  signal: AbortSignal,
): Promise<Result<string, AnalysisError>> => {
  const paths = [`tasks/${task}.json`, `artifacts/${task}-check/verify.py`];
  const hash = createHash("sha256");
  const maximum = guestFileAnswerWorkingBytes(guestFileAnswerCeiling());
  for (const path of paths) {
    try {
      const file = await readHostFile(
        join(bundle, path),
        maximum,
        signal,
        true,
      );
      if (!Buffer.isBuffer(file))
        return err(
          refused(
            `The bundle at ${bundle} holds no readable ${path}.`,
            "Name a task the bundle's export wrote, with its steps and verifier.",
          ),
        );
      hash.update(file);
    } catch (cause: unknown) {
      if (cause instanceof RegularFileCapacityError)
        return err(
          new AnalysisResourceConstraintError(
            MEASURE,
            "capacity",
            "Task file exceeds the host read budget",
            { max_bytes: maximum, path: cause.path },
            { cause },
          ),
        );
      throw cause;
    }
  }
  return ok(hash.digest("hex"));
};

/** One finished report as the record keeps it. */
const solveRecord = (
  report: Extract<SolveReport, { outcome: string }>,
): SolveRecord => ({
  outcome: report.outcome,
  turns: report.turns,
  usd: report.usd,
  seconds: report.seconds,
  failed_checks:
    report.outcome === "passed" || report.outcome === "scored below 1"
      ? report.checks.filter((check) => !check.passed).map((check) => check.id)
      : [],
  instance_id: report.instance_id,
  error: report.error,
});

/** The bundle's difficulty records and README as they stand. */
interface BundleRecords {
  readonly tasks: Readonly<
    Record<string, z.infer<typeof recordsSchema>["tasks"][string]>
  >;
  readonly readme: string;
}

/** The bundle's records, a missing file read as none; a file REA cannot read or parse is refused, so it is never replaced. */
const readRecords = async (
  bundle: string,
  signal: AbortSignal,
): Promise<Result<BundleRecords, AnalysisError>> => {
  const unreadable = (file: string, why: string) =>
    err(
      refused(
        `The bundle's ${file} ${why}, so REA would replace records it cannot keep.`,
        `Repair or move ${join(bundle, file)} and measure again.`,
      ),
    );
  const records = await readHostFile(
    join(bundle, DIFFICULTY_FILE),
    FILE_BYTES,
    signal,
  );
  const readme = await readHostFile(
    join(bundle, README_FILE),
    FILE_BYTES,
    signal,
  );
  if (records === "unreadable")
    return unreadable(DIFFICULTY_FILE, "cannot be read");
  if (readme === "unreadable") return unreadable(README_FILE, "cannot be read");
  let tasks: BundleRecords["tasks"] = {};
  if (records !== "missing") {
    const json = safeParseUtf8Json(records);
    const parsed = json.ok ? recordsSchema.safeParse(json.value) : undefined;
    if (parsed?.success !== true)
      return unreadable(DIFFICULTY_FILE, "is not a difficulty file REA reads");
    tasks = parsed.data.tasks;
  }
  return ok({
    tasks,
    readme: readme === "missing" ? "" : readme.toString("utf8"),
  });
};

/** The record writes under way, by bundle, so a measure merges with the one before it rather than racing it. */
const recording = new Map<string, Promise<unknown>>();

/** Run `write` after every earlier write to the same bundle by this REA. */
const afterEarlierWrites = async <Value>(
  bundle: string,
  write: () => Promise<Value>,
): Promise<Value> => {
  const key = resolve(bundle);
  const earlier = recording.get(key) ?? Promise.resolve();
  const mine = earlier.then(write, write);
  const settled = mine.catch(() => undefined);
  recording.set(key, settled);
  try {
    return await mine;
  } finally {
    if (recording.get(key) === settled) recording.delete(key);
  }
};

/** Record the task's measure in the bundle's difficulty file, beside other tasks', and in its README. */
const recordMeasure = (
  bundle: string,
  task: string,
  record: DifficultyRecord,
  signal: AbortSignal,
  resources: ArtifactResourceScope,
): Promise<Result<string, AnalysisError>> =>
  afterEarlierWrites(bundle, async () => {
    const current = await readRecords(bundle, signal);
    if (!current.ok) return current;
    const tasks = { ...current.value.tasks, [task]: record };
    const path = join(bundle, DIFFICULTY_FILE);
    const saved = await writeTextFile(
      `${JSON.stringify({ tasks }, null, 2)}\n`,
      path,
      true,
      resources,
    );
    if (!saved.ok) return saved;
    const readme = await writeTextFile(
      withDifficultySection(current.value.readme, difficultySection(tasks)),
      join(bundle, README_FILE),
      true,
      resources,
    );
    if (!readme.ok) return readme;
    return ok(path);
  });

/**
 * Measure a bundle's task: solve it in fresh computers, 3 times, then 2 more
 * unless they passed none or all, stopping before a solve the budget cannot
 * cover, and record the band, cost, turns and failures per check in the
 * bundle's difficulty file and README.
 */
export const measureBuildTask = async (
  request: MeasureRequest,
  solver: Solver,
  signal: AbortSignal,
  progress: ProgressReporter = silentProgressReporter,
  resources: ArtifactResourceScope = new ArtifactResourceScope(),
): Promise<Result<MeasuredTask, AnalysisError>> => {
  const taskName = admitTaskName(request.task);
  if (!taskName.ok) return taskName;
  const task = taskName.value;
  const solves: SolveRecord[] = [];
  const retainSolves = (failure: AnalysisError): AnalysisError => {
    if (solves.length > 0)
      failure.retainPartialObservation({
        kind: "partial-task-measurement",
        bundle: request.bundle,
        task: task,
        solves: [...solves],
      });
    return failure;
  };
  let agentenv: string | null = null;
  let stopped: StopReason = "decided";
  try {
    const digest = await taskDigest(request.bundle, task, signal);
    if (!digest.ok) return digest;
    // Refuse records REA could not keep before any solve is paid for.
    const records = await readRecords(request.bundle, signal);
    if (!records.ok) return records;
    for (;;) {
      const decision = nextSolve(solves, request.budget_usd);
      if (!decision.next) {
        stopped = decision.stopped;
        break;
      }
      await progress
        .report({
          phase: MEASURE,
          completed: solves.length,
          total: null,
          message: `solve ${String(solves.length + 1)} of ${task} with ${request.model}`,
        })
        .catch(() => undefined);
      const report = await solver({ ...request, task }, signal);
      if (!("outcome" in report))
        return err(
          retainSolves(
            refused(
              `A solve of ${task} did not run: ${report.error}`,
              "Fix what the error names, such as the model endpoint agentenv needs (LITELLM_BASE_URL and LITELLM_API_KEY where REA starts, or [model] in .agentenv/config.toml), and measure again.",
            ),
          ),
        );
      agentenv = report.agentenv ?? agentenv;
      solves.push(solveRecord(report));
    }
    const record = difficultyRecord({
      model: request.model,
      agent: request.agent,
      solves,
      budgetUsd: request.budget_usd,
      stopped,
      taskSha256: digest.value,
      versions: { rea: PRODUCT_IDENTITY.packageVersion, agentenv },
      measuredAt: new Date().toISOString(),
    });
    const file = await recordMeasure(
      request.bundle,
      task,
      record,
      signal,
      resources,
    );
    if (!file.ok) return err(retainSolves(file.error));
    const { versions: _versions, ...reported } = record;
    return ok({
      bundle: request.bundle,
      task: task,
      ...reported,
      difficulty_file: file.value,
    });
  } catch (cause: unknown) {
    if (
      (cause instanceof SolveCleanupError ||
        cause instanceof SolveCancelledError) &&
      cause.report !== undefined &&
      "outcome" in cause.report
    )
      solves.push(solveRecord(cause.report));
    if (cause instanceof ArtifactFileCleanupFailure) {
      const cleanup = cause.cleanup ?? {
        reason: "an input handle could not be closed",
        resources: [cause.fileCleanupFailure.path],
      };
      for (const lease of cause.cleanupLeases ?? [cause.cleanupLease])
        resources.retain({
          kind: "lease",
          resource: cause.fileCleanupFailure.path,
          lease,
        });
      const cancelled =
        cause.cancellation !== undefined ||
        (signal.aborted &&
          cause.fileCleanupFailure.outcome.kind === "completed");
      const failure = cancelled
        ? new AnalysisCancelledError(MEASURE, {
            cause:
              cause.cancellation === undefined
                ? signal.reason
                : cause.cancellation.reason,
            cleanup,
          })
        : new ProviderAdapterError(AGENTENV_PROVIDER, MEASURE, {
            userMessage: `Measuring ${task} could not close an input file.`,
            cause,
            cleanup,
          });
      bindArtifactFileCleanup(cause, failure);
      return err(retainSolves(failure));
    }
    const failure =
      cause instanceof AnalysisError
        ? cause
        : signal.aborted
          ? new AnalysisCancelledError(MEASURE, { cause: signal.reason })
          : new ProviderAdapterError(AGENTENV_PROVIDER, MEASURE, {
              userMessage: `Measuring ${task} failed after ${String(solves.length)} solve(s): ${errorText(cause)}`,
              remediationAction:
                "Check the bundle files and host I/O error, then retry or retain the completed solve results.",
              cause,
            });
    return err(retainSolves(failure));
  }
};

/** Measure a task with each solve run by REA's helper in the build host's agentenv, with the build settings' defaults. */
export const measureInFreshComputers = async (
  request: MeasureRequest,
  host: {
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly defaults: BuildComputerDefaults;
    readonly retainCleanup: (owner: SolveCleanupOwner) => void;
    readonly resources: ArtifactResourceScope;
  },
  signal: AbortSignal,
  progress?: ProgressReporter,
): Promise<Result<MeasuredTask, AnalysisError>> => {
  const taskName = admitTaskName(request.task);
  if (!taskName.ok) return taskName;
  const environment = await resolveBuildComputerEnvironment(
    host.environment,
    process.platform,
    host.defaults,
  );
  return measureBuildTask(
    { ...request, task: taskName.value },
    (solve, turn) =>
      runSolveHelper({
        ...solve,
        environment,
        signal: turn,
        operation: MEASURE,
        retainCleanup: host.retainCleanup,
      }),
    signal,
    progress,
    host.resources,
  );
};
