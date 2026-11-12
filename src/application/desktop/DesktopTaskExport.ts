import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  isPointerCheck,
  parseDesktopTask,
  type DesktopTask,
  type DesktopTaskCheck,
  type DesktopTaskReader,
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
import {
  DEFAULT_JUDGE_MODEL,
  SCREEN_EXAMPLE_MAX_BYTES,
  SCREEN_JUDGE_VOTES,
  isScreenTask,
  readableChanges,
} from "../../domain/desktop/appTaskScreen.js";
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
  "name" | "paths" | "capturedHome" | "title" | "aptPackage" | "withheld"
> & {
  readonly files: ReadonlyMap<string, DesktopStatePath>;
  readonly identity: HostIdentity;
  /** The seed, and the end a task without its own is checked at. */
  readonly ends: StateEnds;
  /** The capture's checkpoint names, by position. */
  readonly checkpoints: readonly string[];
  /** Views of the text seeds the export rewrites, as it ships them. */
  readonly seedViews: ReadonlyMap<string, TaskFileView>;
  /** Home paths the bundle actually ships, including files that are not text. */
  readonly seeded: ReadonlySet<string>;
  /** Each reader's view of its file, by reader id: at the seed as the bundle ships it, or at a checkpoint's position. */
  readonly readerViews: (
    readers: readonly DesktopTaskReader[],
    at: "seed" | number,
  ) => Promise<ReadonlyMap<string, TaskFileView>>;
  /** The screenshot a build computer took at the seed or at a checkpoint's position, too large to ship, or undefined when there is none. */
  readonly screens: (
    at: "seed" | number,
  ) => Promise<Buffer | "too-large" | undefined>;
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
  /** Whether a task judges the screen, whose app then resets by relaunching when it owns no files. */
  readonly screenJudged?: boolean;
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

/** What a capture's identity check reads of a value: the captured home, or the host's name or user, if it names one. */
const identityProblem = (
  values: readonly string[],
  target: TaskTarget,
): string | undefined => {
  for (const value of values) {
    if (value.includes(target.capturedHome))
      return `names the captured home ${target.capturedHome}, which the computer's home replaces`;
    const named = identityLeftIn(value, target.identity);
    if (named !== undefined)
      return `names ${named}, the capture host's name or user, which the export removes from the seed`;
  }
  return undefined;
};

/** Why a reader cannot run in this app's computer, or undefined. */
const readerProblem = (
  reader: DesktopTaskReader,
  target: TaskTarget,
): string | undefined =>
  isWithinAny(reader.file, target.paths)
    ? identityProblem([...reader.argv, reader.stdin ?? ""], target)
    : `reads ${reader.file}, which is not under the app's owned paths (${target.paths.join(", ") || "none"}); data/get serves only those. For the bundle to own it, capture again naming it with ${STATE_PATH_INPUTS}`;

/** What a reader read for a failing check, for the author to fix the check from, or nothing. */
const readerRead = (
  check: DesktopTaskCheck,
  readers: ReadonlyMap<string, TaskFileView>,
): string => {
  if (!("reader" in check) || check.reader === undefined) return "";
  const read = readers.get(check.reader);
  if (read === undefined || read.view === null) return "";
  const view = read.view;
  const lines =
    read.format === "text" &&
    typeof view === "object" &&
    !Array.isArray(view) &&
    Array.isArray(view.lines)
      ? view.lines.map((line) => JSON.stringify(line)).join(", ")
      : JSON.stringify(view);
  const shown = lines.length > 600 ? `${lines.slice(0, 600)}…` : lines;
  return `; reader ${check.reader} printed: ${shown}`;
};

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
  if (check.kind === "screen_judge")
    return identityProblem([check.question], target);
  if (!isWithinAny(check.file, target.paths))
    return `names ${check.file}, which is not under the app's owned paths (${target.paths.join(", ") || "none"}); data/get serves only those. For the bundle to own it, capture again naming it with ${STATE_PATH_INPUTS}`;
  if ((target.withheld ?? []).some(({ file }) => file === check.file))
    return `names ${check.file}, which the bundle withholds from its seed as sign-in or licence state, and data/get never serves; check a file the bundle seeds`;
  // What the check compares and names; its field names, kind and id label it.
  const { id: _id, kind: _kind, ...fields } = check;
  const named = identityProblem(
    Object.values(fields).flatMap(valueStrings),
    target,
  );
  if (named !== undefined) return named;
  // A reader's view is JSON or lines whatever the file's own format.
  if (
    !isPointerCheck(check) ||
    ("reader" in check && check.reader !== undefined)
  )
    return undefined;
  return [views.seed, views.end].some(
    (at) => at.get(check.file)?.format === "text",
  )
    ? `points into ${check.file}, which is text; use lines_present, lines_absent or line_count`
    : undefined;
};

/**
 * A seed check's view of one file. A file the bundle does not ship is absent,
 * including a lock the capture saw. A shipped text file uses the scrubbed
 * view; any other shipped file uses the captured view.
 */
export const shippedSeedCheckView = (
  seeded: boolean,
  shipped: TaskFileView | undefined,
  captured: TaskFileView | undefined,
): TaskFileView | undefined => (seeded ? (shipped ?? captured) : undefined);

/** The captured views at a checkpoint's position, before export omissions and rewrites. */
const capturedViewsAt = (
  target: TaskTarget,
  at: number,
): ReadonlyMap<string, TaskFileView> => {
  const views = new Map<string, TaskFileView>();
  for (const [home, path] of target.files) {
    const version = versionAt(path, at);
    const view = version === undefined ? undefined : versionView(version);
    if (view !== undefined) views.set(home, view);
  }
  return views;
};

/** Apply the bundle's omissions and rewritten files to its captured seed. */
const shippedSeedViews = (
  target: TaskTarget,
  captured: ReadonlyMap<string, TaskFileView>,
): ReadonlyMap<string, TaskFileView> => {
  const views = new Map<string, TaskFileView>();
  for (const [home, path] of target.files) {
    const version = versionAt(path, target.ends.seed);
    // A file not retained at the seed is not seeded, so the computer starts without it.
    if (version?.present === true && version.sha256 === null) continue;
    const view = shippedSeedCheckView(
      target.seeded.has(home),
      target.seedViews.get(home),
      captured.get(home),
    );
    if (view !== undefined) views.set(home, view);
  }
  return views;
};

/** The README's list of a task's readers, if it has any. */
const readersReadme = (task: DesktopTask): string =>
  task.readers === undefined
    ? ""
    : `
Readers, each run in the computer on a private copy of its file in a fresh home, without the display unless it asks
for it; the lines it prints starting with \`REA \` are its view:

${task.readers.map((reader) => `- \`${reader.id}\` reads \`${reader.file}\` as ${reader.output}: \`${JSON.stringify(reader.argv)}\`${reader.stdin === undefined ? "" : `, with stdin \`${JSON.stringify(reader.stdin)}\``}`).join("\n")}
`;

const taskReadme = (
  task: DesktopTask,
  app: string,
  summary: TaskSummary,
): string => `
## Task \`${task.name}\`

\`tasks/${task.name}.json\` deploys the app, has the agent work through the computer from the prompt below, and grades
the outcome with \`artifacts/${taskVerifierArtifact(task)}/verify.py\`, which reads the app's \`data/get\` views${task.readers === undefined ? "" : " and runs its readers in the computer"} and needs
no model. It grades once the app's files have held for ${String(SETTLE_TIMING.windowMs / 1000)} s, so a save the app makes on its own within that
time of the agent stopping counts; each result's \`settled\` is false when they were still changing ${String(SETTLE_TIMING.boundMs / 1000)} s after the
first read. \`evals/${app}.toml\` names it, so a run of the bundle runs it.

${task.prompt
  .split("\n")
  .map((line) => `> ${line}`)
  .join("\n")}

Checks, each of which must pass:

${task.checks.map(({ id, ...check }) => `- \`${id}\`: \`${JSON.stringify(check)}\``).join("\n")}
${readersReadme(task)}
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

/** Refuse a check or reader this app's computer cannot serve, naming it after `lead`, which names the task. */
const refuseTargetProblems = (
  task: DesktopTask,
  target: TaskTarget,
  views: TaskViews,
  lead: string,
): void => {
  for (const check of task.checks) {
    const problem = targetProblem(check, target, views);
    if (problem !== undefined)
      throw refuse(
        `${lead}Check ${JSON.stringify(check.id)} ${problem}.`,
        "task",
        REWRITE,
      );
  }
  for (const reader of task.readers ?? []) {
    const problem = readerProblem(reader, target);
    if (problem !== undefined)
      throw refuse(
        `${lead}Reader ${JSON.stringify(reader.id)} ${problem}.`,
        "task",
        REWRITE,
      );
  }
};

/** The readers' views at a checkpoint's position, as retained, or at the seed, as the bundle ships it: the app's own headless mode on those bytes. */
const readersAt = async (
  task: DesktopTask,
  target: TaskTarget,
  at: "seed" | number,
): Promise<ReadonlyMap<string, TaskFileView>> => {
  const readers = task.readers ?? [];
  return readers.length === 0 ? new Map() : target.readerViews(readers, at);
};

/** The README's section on a screen-judged task: its questions and how its judge is configured. */
const screenReadme = (task: DesktopTask, app: string): string => `
## Task \`${task.name}\`

\`tasks/${task.name}.json\` deploys the app, has the agent work through the computer from the prompt below, and grades
the outcome with \`artifacts/${taskVerifierArtifact(task)}/verify.py\`, which takes a screenshot of the computer once the
agent stops and asks a model, the judge, each question below ${String(SCREEN_JUDGE_VOTES)} times; a check passes when most answers are yes. The
judge sees two labelled screenshots from the build first: the app at the seed, where the answer is no, and with the
task done, where it is yes. \`evals/${app}.toml\` names the task, so a run of the bundle runs it.

${task.prompt
  .split("\n")
  .map((line) => `> ${line}`)
  .join("\n")}

Questions, each of which must be answered yes:

${task.checks.map((check) => `- \`${check.id}\`: ${check.kind === "screen_judge" ? check.question : ""}`).join("\n")}

The judge's model is \`[model.roles] judge\` in the runner's \`.agentenv/config.toml\`, else its \`[model] default\`, else
\`${DEFAULT_JUDGE_MODEL}\`, called through \`LITELLM_BASE_URL\` and \`LITELLM_API_KEY\` or \`[model] base_url\` and \`api_key\`.
\`agent-env run --judge-model\` does not reach it. Without an endpoint the verifier raises, so the run fails rather than
scoring the agent. The export judged no screen; REA's witness ran this judge on a fresh screenshot at each stage.

To measure a solve rate, run the task k times (3 by default) and count the runs whose summary line says \`passed\`:

    agent-env run <this folder> --task ${task.name} --agent claude-code --model MODEL
`;

/** One task the export kept: its summary, README section, verifier, and what the export says about it. */
interface AdmittedTask {
  readonly summary: TaskSummary;
  readonly readme: string;
  readonly verifier: string;
  readonly limitations: readonly string[];
  readonly screenJudged: boolean;
}

/** Where a task is checked: its end, and the checkpoint its change was made on top of, the seed or the task end before it. */
interface TaskAt {
  readonly end: number;
  readonly before: number;
}

/**
 * Admit a screen-judged task: no file shows its change since the checkpoint
 * it was made on top of, and the build's screenshots at the seed and at the
 * task's end ship as the judge's examples.
 */
const admitScreenTask = async (
  task: DesktopTask,
  target: TaskTarget,
  at: TaskAt,
  lead: string,
): Promise<AdmittedTask> => {
  // Only a file the app owns could take a check instead; the export refuses the rest.
  const owned = (all: ReadonlyMap<string, TaskFileView>) =>
    new Map([...all].filter(([file]) => isWithinAny(file, target.paths)));
  const changed = readableChanges(
    owned(capturedViewsAt(target, at.before)),
    owned(capturedViewsAt(target, at.end)),
  );
  if (changed.length > 0)
    throw refuse(
      `${lead}A screen_judge judges state no file shows, but ${changed.join(", ")} changed between ${at.before === target.ends.seed ? "the seed and the end" : `${target.checkpoints[at.before] ?? "the task before"} and ${target.checkpoints[at.end] ?? "its end"}`} in a way a check can read.`,
      "task",
      `Check what changed in those files instead; ${DRAFT}.`,
    );
  const [seed, end] = await Promise.all([
    target.screens("seed"),
    target.screens(at.end),
  ]);
  if (seed === undefined || end === undefined)
    throw refuse(
      `${lead}A screen_judge needs the screenshots a build computer takes at the seed and end checkpoints, its judge's examples, and the capture has no ${seed === undefined ? "seed" : "end"} screenshot.`,
      "task",
      "Capture the app in a build computer, marking seed and end there, and export from it.",
    );
  if (seed === "too-large" || end === "too-large")
    throw refuse(
      `${lead}The ${seed === "too-large" ? "seed" : "end"} screenshot is larger than the ${String(SCREEN_EXAMPLE_MAX_BYTES / 1024 / 1024)} MiB a judge's example may take.`,
      "task",
      "Capture again with a simpler screen at that checkpoint.",
    );
  const examples = {
    fail: seed.toString("base64"),
    pass: end.toString("base64"),
  };
  return {
    screenJudged: true,
    summary: {
      name: task.name,
      checks: task.checks.length,
      end_checkpoint: target.checkpoints[at.end] ?? "baseline",
      failing_on_seed: [],
      near_checkpoint: null,
      failing_on_near: [],
    },
    limitations: [
      ...(namesApp(task.prompt, target)
        ? []
        : [
            `The prompt of task ${task.name} does not name the app (${target.title}), so start it with "In ${target.title}, ".`,
          ]),
      `The export judges no screen, so it did not check task ${task.name}'s screen_judge questions on the seed, the end or a near miss: the witness does, running the bundle's own judge on a fresh screenshot at each stage, which needs a model endpoint.`,
    ],
    readme: screenReadme(task, target.name),
    verifier: renderTaskVerifier(task, target.name, examples),
  };
};

/** Whether a prompt names the app by its title, environment or package, in any letter case. */
export const namesApp = (
  prompt: string,
  {
    title,
    name,
    aptPackage,
  }: Pick<TaskTarget, "title" | "name" | "aptPackage">,
): boolean => {
  return [title, name, aptPackage].some((app) => {
    const spelled = app.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(
      `(?<![\\p{L}\\p{N}_])${spelled}(?![\\p{L}\\p{N}_])`,
      "iu",
    ).test(prompt);
  });
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
const admitTask = async (
  task: DesktopTask,
  at: TaskAt,
  target: TaskTarget,
): Promise<AdmittedTask> => {
  const { end } = at;
  const endName = target.checkpoints[end] ?? "baseline";
  const nearName = nearCheckpoint(task.name);
  const near = target.checkpoints.includes(nearName)
    ? positionOf(target, nearName)
    : undefined;
  const views: TaskViews = {
    seed: shippedSeedViews(target, capturedViewsAt(target, target.ends.seed)),
    end: capturedViewsAt(target, end),
    near: near === undefined ? undefined : capturedViewsAt(target, near),
  };
  const lead = `Task ${JSON.stringify(task.name)}, checked at ${endName}: `;
  refuseTargetProblems(task, target, views, lead);
  if (isScreenTask(task)) return admitScreenTask(task, target, at, lead);
  const read = {
    end: await readersAt(task, target, end),
    seed: await readersAt(task, target, "seed"),
    near: near === undefined ? undefined : await readersAt(task, target, near),
  };
  const failing = evaluateTaskChecks(task.checks, views.end, read.end).find(
    (outcome) => !outcome.passed,
  );
  if (failing !== undefined) {
    const check = task.checks.find(({ id }) => id === failing.id);
    throw refuse(
      `${lead}Check ${JSON.stringify(failing.id)} fails on the captured end state: ${failing.description}${check === undefined ? "" : readerRead(check, read.end)}.`,
      "task",
      `Write checks that the captured end state passes, or check the task at the checkpoint taken once its change was saved; ${DRAFT}.`,
    );
  }
  const seed = evaluateTaskChecks(task.checks, views.seed, read.seed).filter(
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
      : evaluateTaskChecks(task.checks, views.near, read.near).filter(
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
  const summary: TaskSummary = {
    name: task.name,
    checks: task.checks.length,
    end_checkpoint: endName,
    failing_on_seed: failingOnSeed,
    near_checkpoint: near === undefined ? null : nearName,
    failing_on_near: failingOnNear,
  };
  return {
    summary,
    screenJudged: false,
    limitations: namesApp(task.prompt, target)
      ? []
      : [
          `The prompt of task ${task.name} does not name the app (${target.title}): a solving agent's own shell cannot see the computer's files, and the app's name sends it to the screen, so start the prompt with "In ${target.title}, ".`,
        ],
    readme: taskReadme(task, target.name, summary),
    verifier: renderTaskVerifier(task, target.name),
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

/** The checkpoint a task's change was made on top of: the latest of the seed and the other tasks' ends before its own. */
const changedFrom = (
  end: number,
  seed: number,
  ends: readonly number[],
): number => Math.max(seed, ...ends.filter((other) => other < end));

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
    const parsed = parseDesktopTask(await readTaskFile(path, signal));
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
  const positions = tasks.map((task) => {
    const named = ends.get(task.name);
    return named === undefined ? target.ends.end : positionOf(target, named);
  });
  const admitted: AdmittedTask[] = [];
  // One at a time: a task's readers run the app's own headless mode.
  for (const [index, task] of tasks.entries()) {
    const end = positions[index] as number;
    admitted.push(
      await admitTask(
        task,
        { end, before: changedFrom(end, target.ends.seed, positions) },
        target,
      ),
    );
  }
  return {
    summaries: admitted.map(({ summary }) => summary),
    ...(admitted.some(({ screenJudged }) => screenJudged)
      ? { screenJudged: true }
      : {}),
    limitations: admitted.flatMap(({ limitations }) => limitations),
    readme: admitted.map(({ readme }) => readme).join(""),
    files: [
      ...tasks.flatMap((task, index) => [
        {
          path: `tasks/${task.name}.json`,
          content: renderTaskSteps(task, target.name),
        },
        {
          path: `artifacts/${taskVerifierArtifact(task)}/verify.py`,
          content: (admitted[index] as AdmittedTask).verifier,
        },
      ]),
      { path: `evals/${target.name}.toml`, content: renderTaskEval(tasks) },
    ],
  };
};
