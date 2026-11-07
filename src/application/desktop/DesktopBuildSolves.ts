import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
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
  type SolveReport,
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
  const files = await Promise.all(
    paths.map((path) => readHostFile(join(bundle, path), FILE_BYTES, signal)),
  );
  const missing = paths.filter((_, index) => !Buffer.isBuffer(files[index]));
  if (missing.length > 0)
    return err(
      refused(
        `The bundle at ${bundle} holds no task ${task}: it has no readable ${missing.join(" or ")}.`,
        "Name a task the bundle's export wrote, with its steps and verifier.",
      ),
    );
  const hash = createHash("sha256");
  for (const file of files) if (Buffer.isBuffer(file)) hash.update(file);
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
});

/** Write a file of the bundle whole: a partial one is renamed over it only once written. */
const replaceFile = async (path: string, content: string): Promise<void> => {
  const partial = `${path}.rea-${randomUUID()}.partial`;
  try {
    await writeFile(partial, content);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
};

/** Record the task's measure in the bundle's difficulty file, beside other tasks', and in its README. */
const recordMeasure = async (
  bundle: string,
  task: string,
  record: DifficultyRecord,
  signal: AbortSignal,
): Promise<string> => {
  const path = join(bundle, DIFFICULTY_FILE);
  const previous = await readHostFile(path, FILE_BYTES, signal);
  const json = Buffer.isBuffer(previous)
    ? safeParseUtf8Json(previous)
    : undefined;
  const parsed =
    json?.ok === true ? recordsSchema.safeParse(json.value) : undefined;
  const tasks = {
    ...(parsed?.success === true ? parsed.data.tasks : {}),
    [task]: record,
  };
  await replaceFile(path, `${JSON.stringify({ tasks }, null, 2)}\n`);
  const readmePath = join(bundle, "README.md");
  const readme = await readFile(readmePath, "utf8").catch(() => "");
  await replaceFile(
    readmePath,
    withDifficultySection(readme, difficultySection(tasks)),
  );
  return path;
};

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
): Promise<Result<MeasuredTask, AnalysisError>> => {
  const digest = await taskDigest(request.bundle, request.task, signal);
  if (!digest.ok) return digest;
  const solves: SolveRecord[] = [];
  let agentenv: string | null = null;
  let stopped: StopReason = "decided";
  try {
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
          message: `solve ${String(solves.length + 1)} of ${request.task} with ${request.model}`,
        })
        .catch(() => undefined);
      const report = await solver(request, signal);
      if (!("outcome" in report))
        return err(
          refused(
            `A solve of ${request.task} did not run: ${report.error}`,
            "Fix what the error names, such as the model endpoint agentenv needs (LITELLM_BASE_URL and LITELLM_API_KEY where REA starts, or [model] in .agentenv/config.toml), and measure again.",
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
      request.task,
      record,
      signal,
    );
    const { versions: _versions, ...reported } = record;
    return ok({
      bundle: request.bundle,
      task: request.task,
      ...reported,
      difficulty_file: file,
    });
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return err(cause);
    return err(
      signal.aborted
        ? new AnalysisCancelledError(MEASURE, { cause: signal.reason })
        : new ProviderAdapterError(AGENTENV_PROVIDER, MEASURE, {
            userMessage: `Measuring ${request.task} failed after ${String(solves.length)} solve(s): ${errorText(cause)}`,
            cause,
          }),
    );
  }
};

/** Measure a task with each solve run by REA's helper in the build host's agentenv, with the build settings' defaults. */
export const measureInFreshComputers = async (
  request: MeasureRequest,
  host: {
    readonly environment: Readonly<NodeJS.ProcessEnv>;
    readonly defaults: BuildComputerDefaults;
  },
  signal: AbortSignal,
  progress?: ProgressReporter,
): Promise<Result<MeasuredTask, AnalysisError>> => {
  const environment = await resolveBuildComputerEnvironment(
    host.environment,
    process.platform,
    host.defaults,
  );
  return measureBuildTask(
    request,
    (solve, turn) =>
      runSolveHelper({
        ...solve,
        environment,
        signal: turn,
        operation: MEASURE,
      }),
    signal,
    progress,
  );
};
