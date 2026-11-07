import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  isPointerCheck,
  parseDesktopTask,
  type DesktopTask,
  type DesktopTaskCheck,
} from "../../domain/desktop/appTask.js";
import {
  evaluateTaskChecks,
  versionView,
  type TaskCheckOutcome,
  type TaskFileView,
} from "../../domain/desktop/appTaskChecks.js";
import { SETTLE_TIMING } from "../../domain/desktop/appSettle.js";
import {
  renderTaskEval,
  renderTaskSteps,
  renderTaskVerifier,
  taskVerifierArtifact,
} from "../../domain/desktop/appTaskPython.js";
import type { DesktopAppExportPlan } from "../../domain/desktop/appExport.js";
import { STATE_PATH_INPUTS } from "../../domain/desktop/buildCapture.js";
import {
  versionAt,
  type DesktopStatePath,
  type StateEnds,
} from "../../domain/desktop/desktopState.js";
import {
  identityLeftIn,
  type HostIdentity,
} from "../../domain/desktop/hostIdentity.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { EvidenceFileError } from "../../domain/evidenceErrors.js";
import { err } from "../../domain/result.js";
import { describeValidationFailure } from "../../domain/validationFailure.js";
import { isWithinAny } from "../../domain/desktop/desktopStateDiff.js";
import { isPortableBundleName } from "../environment/environmentBundle.js";
import { readJsonFile } from "../JsonFiles.js";
import { desktopOperationFailure } from "./DesktopCaptureRefusals.js";
import { refuse } from "./DesktopExportInstall.js";
import { selectStateEnds } from "./DesktopStateVersions.js";

const OPERATION = "export_desktop_application";
const REWRITE = "Fix the task file and export again.";
/** Where the change shows on either path: a capture inside a build computer cannot be described with the CLI, so its draft comes from stop_build_capture. */
const DRAFT =
  "each changed file's values in the task draft (describe-desktop-application-task, or stop_build_capture on a build computer) show what it held at the seed and at the end, at the pointer a check names it by";

/** What the export knows of the app: its name, owned paths, captured home, host identity, state files by home path and the checkpoints it reads. */
type TaskTarget = Pick<
  DesktopAppExportPlan,
  "name" | "paths" | "capturedHome" | "title" | "aptPackage"
> & {
  readonly files: ReadonlyMap<string, DesktopStatePath>;
  readonly identity: HostIdentity;
  /** The seed, and the end a task without its own is checked at. */
  readonly ends: StateEnds;
  /** The capture's checkpoint names, by position. */
  readonly checkpoints: readonly string[];
  /** Views of the seeds the export rewrites, as it ships them. */
  readonly seedViews: ReadonlyMap<string, TaskFileView>;
};

/** What the export says of one task it kept. */
export interface TaskSummary {
  readonly name: string;
  readonly checks: number;
  readonly end_checkpoint: string;
  readonly failing_on_seed: string[];
  /** The checkpoint of the task's near miss, `near-<name>`, when the capture took one. */
  readonly near_checkpoint: string | null;
  readonly failing_on_near: string[];
}

/** The tasks the capture validated: the files they add to the bundle, their README sections and their summaries. */
export interface AdmittedTasks {
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly readme: string;
  /** What the export says about the tasks, such as a prompt that does not name the app. */
  readonly limitations: readonly string[];
  readonly summaries: readonly TaskSummary[];
}

/** Why the task file could not be read, with the reader's detail and its error as the cause. */
const taskFileFailure = (path: string, error: AnalysisError): AnalysisError => {
  if (!(error instanceof EvidenceFileError) || error.reason === "io")
    return error;
  const detail = describeValidationFailure(error.cause);
  const json = error.reason === "invalid-json";
  const userMessage = json
    ? `The task file ${path} is not valid UTF-8 JSON (${detail}).`
    : `The task file ${path} could not be read (${detail}).`;
  return new AnalysisInputError(
    OPERATION,
    {
      userMessage,
      remediationAction: json
        ? "Repair the task file, then export again."
        : "Pass a regular JSON file, such as the task describe-desktop-application-task drafts.",
      conformsToInputContract: true,
      cause: error,
    },
    [{ path: ["task"], reason: "invalid_value", message: userMessage }],
  );
};

/** The task file's JSON; a failed cleanup is reported with the read failure, if any, as its primary. */
const readTaskFile = async (
  path: string,
  signal: AbortSignal | undefined,
): Promise<unknown> => {
  const resources = new ArtifactResourceScope();
  const loaded = await readJsonFile(path, signal, resources, OPERATION).catch(
    (cause: unknown) => err(cause),
  );
  const typed = (cause: unknown) =>
    desktopOperationFailure(cause, signal, OPERATION, "Reading the task file");
  const closed = await resources.close().then(() => undefined, typed);
  const primary = loaded.ok
    ? undefined
    : taskFileFailure(path, typed(loaded.error));
  if (closed !== undefined)
    throw primary === undefined
      ? closed
      : analysisErrorWithCleanupFailure(primary, closed, OPERATION);
  if (loaded.ok) return loaded.value;
  throw primary ?? typed(loaded.error);
};

/** The task's views of every file at its seed, as the bundle ships it, at its end and at its near miss. */
interface TaskViews {
  readonly seed: ReadonlyMap<string, TaskFileView>;
  readonly end: ReadonlyMap<string, TaskFileView>;
  readonly near: ReadonlyMap<string, TaskFileView> | undefined;
}

/** Every string in a value, member names included. */
const valueStrings = (value: JsonValue | undefined): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(valueStrings);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([name, member]) => [
    name,
    ...valueStrings(member),
  ]);
};

/** Why a check cannot be validated against this app, or undefined. */
const targetProblem = (
  check: DesktopTaskCheck,
  target: TaskTarget,
  views: TaskViews,
): string | undefined => {
  if (!isWithinAny(check.file, target.paths))
    return `names ${check.file}, which is not under the app's owned paths (${target.paths.join(", ") || "none"}); data/get serves only those. For the bundle to own it, capture again naming it with ${STATE_PATH_INPUTS}`;
  // What the check compares and names; its field names, kind and id label it.
  const { id: _id, kind: _kind, ...fields } = check;
  for (const value of Object.values(fields).flatMap(valueStrings)) {
    if (value.includes(target.capturedHome))
      return `names the captured home ${target.capturedHome}, which the computer's home replaces`;
    const named = identityLeftIn(value, target.identity);
    if (named !== undefined)
      return `names ${named}, the capture host's name or user, which the export removes from the seed`;
  }
  if (!isPointerCheck(check)) return undefined;
  return [views.seed, views.end].some(
    (at) => at.get(check.file)?.format === "text",
  )
    ? `points into ${check.file}, which is text; use lines_present, lines_absent or line_count`
    : undefined;
};

/** Views of every file at a checkpoint's position, or at the seed as the bundle ships it. */
const viewsAt = (
  target: TaskTarget,
  at: number | "seed",
): ReadonlyMap<string, TaskFileView> => {
  const views = new Map<string, TaskFileView>();
  const seed = at === "seed";
  for (const [home, path] of target.files) {
    const version = versionAt(path, seed ? target.ends.seed : at);
    // A file not retained at the seed is not seeded, so the computer starts without it.
    if (seed && version?.present === true && version.sha256 === null) continue;
    const shipped = seed ? target.seedViews.get(home) : undefined;
    const view =
      shipped ?? (version === undefined ? undefined : versionView(version));
    if (view !== undefined) views.set(home, view);
  }
  return views;
};

const taskReadme = (
  task: DesktopTask,
  app: string,
  summary: TaskSummary,
): string => `
## Task \`${task.name}\`

\`tasks/${task.name}.json\` deploys the app, has the agent work through the computer from the prompt below, and grades
the outcome with \`artifacts/${taskVerifierArtifact(task)}/verify.py\`, which reads the app's \`data/get\` views and needs
no model. It grades once the app's files have held for ${String(SETTLE_TIMING.windowMs / 1000)} s, so a save the app makes on its own within that
time of the agent stopping counts; each result's \`settled\` is false when they were still changing ${String(SETTLE_TIMING.boundMs / 1000)} s after the
first read. \`evals/${app}.toml\` names it, so a run of the bundle runs it.

${task.prompt
  .split("\n")
  .map((line) => `> ${line}`)
  .join("\n")}

Checks, each of which must pass:

${task.checks.map(({ id, ...check }) => `- \`${id}\`: \`${JSON.stringify(check)}\``).join("\n")}

REA kept the task because its checks fail on the seed (${ids(summary.failing_on_seed)}) and all
pass at the captured end state, checkpoint \`${summary.end_checkpoint}\`${
  summary.near_checkpoint === null
    ? ""
    : `, and its near miss, checkpoint \`${summary.near_checkpoint}\`, fails ${ids(summary.failing_on_near)}`
}.

To measure a solve rate, run the task k times (3 by default) with the agent and model to measure, and count the runs
whose summary line says \`passed\`; a run that says \`failed\` did not finish and is run again rather than counted:

    agent-env run <this folder> --task ${task.name} --agent claude-code --model MODEL
`;

const ids = (checks: readonly string[]) =>
  checks.map((id) => `\`${id}\``).join(", ");

/** Whether a prompt names the app by its title, environment or package, in any letter case. */
const namesApp = (
  prompt: string,
  {
    title,
    name,
    aptPackage,
  }: Pick<TaskTarget, "title" | "name" | "aptPackage">,
): boolean => {
  const said = prompt.toLowerCase();
  return [title, name, aptPackage].some((app) =>
    said.includes(app.toLowerCase()),
  );
};

/** The checkpoint a task's near miss is taken at. */
const nearCheckpoint = (task: string): string => `near-${task}`;

/** Each task's own end checkpoint, from `NAME=CHECKPOINT`, by task name. */
const taskEndsOf = (
  given: readonly string[],
  names: ReadonlySet<string>,
): ReadonlyMap<string, string> => {
  const ends = new Map<string, string>();
  for (const entry of given) {
    const at = entry.indexOf("=");
    const name = entry.slice(0, at);
    const checkpoint = entry.slice(at + 1);
    if (at <= 0 || checkpoint === "")
      throw refuse(
        `The task end ${JSON.stringify(entry)} is not NAME=CHECKPOINT.`,
        "task_end",
        "Give each task end as the task's name, =, and the checkpoint it is checked at.",
      );
    if (!names.has(name) || ends.has(name))
      throw refuse(
        `The task end ${JSON.stringify(entry)} names ${JSON.stringify(name)}, ${ends.has(name) ? "whose end is already given" : "which is none of the tasks given"}.`,
        "task_end",
        "Give one end for each task, by the name in its task file.",
      );
    ends.set(name, checkpoint);
  }
  return ends;
};

/** A checkpoint's position, refused unless the capture took it once, at or after the seed. */
const positionOf = (target: TaskTarget, checkpoint: string): number =>
  selectStateEnds(
    target.checkpoints,
    { seed: target.checkpoints[target.ends.seed], end: checkpoint },
    OPERATION,
  ).end;

/** One task validated at the seed, at its own end and, when the capture took one, at its near miss. */
const admitTask = (
  task: DesktopTask,
  end: number,
  target: TaskTarget,
): TaskSummary => {
  const endName = target.checkpoints[end] ?? "baseline";
  const nearName = nearCheckpoint(task.name);
  const near = target.checkpoints.includes(nearName)
    ? positionOf(target, nearName)
    : undefined;
  const views: TaskViews = {
    seed: viewsAt(target, "seed"),
    end: viewsAt(target, end),
    near: near === undefined ? undefined : viewsAt(target, near),
  };
  const lead = `Task ${JSON.stringify(task.name)}, checked at ${endName}: `;
  for (const check of task.checks) {
    const problem = targetProblem(check, target, views);
    if (problem !== undefined)
      throw refuse(
        `${lead}Check ${JSON.stringify(check.id)} ${problem}.`,
        "task",
        REWRITE,
      );
  }
  const failing = evaluateTaskChecks(task.checks, views.end).find(
    (outcome) => !outcome.passed,
  );
  if (failing !== undefined)
    throw refuse(
      `${lead}Check ${JSON.stringify(failing.id)} fails on the captured end state: ${failing.description}.`,
      "task",
      `Write checks that the captured end state passes, or check the task at the checkpoint taken once its change was saved; ${DRAFT}.`,
    );
  const seed = evaluateTaskChecks(task.checks, views.seed).filter(
    (outcome) => !outcome.passed,
  );
  if (seed.length === 0)
    throw refuse(
      `${lead}Every check already passes on the seed, so the task would be done before the agent starts.`,
      "task",
      "Add a check that the change the user made is needed for.",
    );
  // Only a failure on what the seed's view shows proves the task is not done yet.
  const failingOnSeed = decidedFailures(seed);
  if (failingOnSeed.length === 0)
    throw refuse(
      `${lead}No check fails on what the seed's views show: each failure there may come from a view that could not be read or is cut short (${undecided(seed)}).`,
      "task",
      `Add a check that fails on what the seed's views hold, such as a line or row of a file read whole; ${DRAFT}.`,
    );
  const missed =
    views.near === undefined
      ? []
      : evaluateTaskChecks(task.checks, views.near).filter(
          (outcome) => !outcome.passed,
        );
  const failingOnNear = decidedFailures(missed);
  if (views.near !== undefined && failingOnNear.length === 0)
    throw refuse(
      missed.length === 0
        ? `${lead}Every check passes at ${nearName}, its near miss, so the checks would accept that almost-right change.`
        : `${lead}No check fails on what ${nearName}'s views show, its near miss: each failure there may come from a view that could not be read or is cut short (${undecided(missed)}).`,
      "task",
      `Tighten the checks so the near miss fails one, or take ${nearName} again on a near miss the task's checks are meant to catch.`,
    );
  return {
    name: task.name,
    checks: task.checks.length,
    end_checkpoint: endName,
    failing_on_seed: failingOnSeed,
    near_checkpoint: near === undefined ? null : nearName,
    failing_on_near: failingOnNear,
  };
};

const decidedFailures = (failed: readonly TaskCheckOutcome[]): string[] =>
  failed
    .filter((outcome) => outcome.undecided !== true)
    .map((outcome) => outcome.id);

const undecided = (failed: readonly TaskCheckOutcome[]): string =>
  failed
    .map(({ id, description }) => `${JSON.stringify(id)}: ${description}`)
    .join("; ");

/** Read, validate and render the tasks a caller passed with the export, each at its own end checkpoint; undefined for none. */
export const admitDesktopTasks = async (
  given: {
    readonly paths: readonly string[];
    readonly ends: readonly string[];
  },
  target: TaskTarget,
  signal: AbortSignal | undefined,
): Promise<AdmittedTasks | undefined> => {
  const tasks: DesktopTask[] = [];
  for (const path of given.paths) {
    const parsed = parseDesktopTask(
      await readTaskFile(path, signal),
      isPortableBundleName,
    );
    if (!parsed.ok)
      throw refuse(
        `The task file ${path} is refused: ${parsed.error}`,
        "task",
        REWRITE,
      );
    if (tasks.some((task) => task.name === parsed.value.name))
      throw refuse(
        `Two tasks are named ${JSON.stringify(parsed.value.name)}; the bundle names each task's files after it.`,
        "task",
        "Give each task its own name.",
      );
    tasks.push(parsed.value);
  }
  const ends = taskEndsOf(given.ends, new Set(tasks.map((task) => task.name)));
  if (tasks.length === 0) return undefined;
  const summaries = tasks.map((task) => {
    const named = ends.get(task.name);
    return admitTask(
      task,
      named === undefined ? target.ends.end : positionOf(target, named),
      target,
    );
  });
  return {
    summaries,
    limitations: tasks
      .filter((task) => !namesApp(task.prompt, target))
      .map(
        (task) =>
          `The prompt of task ${task.name} does not name the app (${target.title}): a solving agent's own shell cannot see the computer's files, and the app's name sends it to the screen, so start the prompt with "In ${target.title}, ".`,
      ),
    readme: tasks
      .map((task, index) =>
        taskReadme(task, target.name, summaries[index] as TaskSummary),
      )
      .join(""),
    files: [
      ...tasks.flatMap((task) => [
        {
          path: `tasks/${task.name}.json`,
          content: renderTaskSteps(task, target.name),
        },
        {
          path: `artifacts/${taskVerifierArtifact(task)}/verify.py`,
          content: renderTaskVerifier(task, target.name),
        },
      ]),
      { path: `evals/${target.name}.toml`, content: renderTaskEval(tasks) },
    ],
  };
};
