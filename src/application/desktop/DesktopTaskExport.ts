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
import { isPortableBundleName } from "../environment/environmentBundle.js";
import { readJsonFile } from "../JsonFiles.js";
import { desktopOperationFailure } from "./DesktopCaptureRefusals.js";
import { refuse } from "./DesktopExportInstall.js";

const OPERATION = "export_desktop_application";
const REWRITE = "Fix the task file and export again.";
/** Where the change shows on either path: a capture inside a build computer cannot be described with the CLI, so its draft comes from stop_build_capture. */
const DRAFT =
  "each changed file's values in the task draft (describe-desktop-application-task, or stop_build_capture on a build computer) show what it held at the seed and at the end, at the pointer a check names it by";

/** What the export knows of the app: its name, owned paths, captured home, host identity, state files by home path and the checkpoints it reads. */
type TaskTarget = Pick<
  DesktopAppExportPlan,
  "name" | "paths" | "capturedHome" | "title" | "aptPackage" | "seedFiles"
> & {
  readonly files: ReadonlyMap<string, DesktopStatePath>;
  readonly identity: HostIdentity;
  readonly ends: StateEnds;
  /** Views of the seeds the export rewrites, as it ships them. */
  readonly seedViews: ReadonlyMap<string, TaskFileView>;
  /** Each reader's view of its file, by reader id: at the seed as the bundle ships it, or at the end. */
  readonly readerViews: (
    readers: readonly DesktopTaskReader[],
    end: keyof StateEnds,
  ) => Promise<ReadonlyMap<string, TaskFileView>>;
  /** The screenshot a build computer took at the seed or the end, too large to ship, or undefined when there is none. */
  readonly screens: (
    end: keyof StateEnds,
  ) => Promise<Buffer | "too-large" | undefined>;
};

/** A task the capture validated: the files it adds to the bundle, its README section and its summary. */
export interface AdmittedTask {
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly readme: string;
  /** What the export says about the task, such as a prompt that does not name the app. */
  readonly limitations: readonly string[];
  /** Whether the task judges the screen, whose app then resets by relaunching when it owns no files. */
  readonly screenJudged?: boolean;
  readonly summary: {
    readonly name: string;
    readonly checks: number;
    readonly failing_on_seed: string[];
  };
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

/** The task's views of every file at its seed, as the bundle ships it, and at its end. */
interface TaskViews {
  readonly seed: ReadonlyMap<string, TaskFileView>;
  readonly end: ReadonlyMap<string, TaskFileView>;
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

/** The captured views at a checkpoint, before export omissions and rewrites. */
const capturedViewsAt = (
  target: TaskTarget,
  end: keyof StateEnds,
): ReadonlyMap<string, TaskFileView> => {
  const views = new Map<string, TaskFileView>();
  for (const [home, path] of target.files) {
    const version = versionAt(path, target.ends[end]);
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
  for (const home of target.seedFiles) {
    const view = target.seedViews.get(home) ?? captured.get(home);
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
  failingOnSeed: readonly string[],
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
REA kept the task because its checks fail on the seed (${failingOnSeed.map((id) => `\`${id}\``).join(", ")}) and all
pass on the captured end state.

To measure a solve rate, run the task k times (3 by default) with the agent and model to measure, and count the runs
whose summary line says \`passed\`; a run that says \`failed\` did not finish and is run again rather than counted:

    agent-env run <this folder> --task ${task.name} --agent claude-code --model MODEL
`;

/** Refuse a check or reader this app's computer cannot serve, naming it. */
const refuseTargetProblems = (
  task: DesktopTask,
  target: TaskTarget,
  views: TaskViews,
): void => {
  for (const check of task.checks) {
    const problem = targetProblem(check, target, views);
    if (problem !== undefined)
      throw refuse(
        `Check ${JSON.stringify(check.id)} ${problem}.`,
        "task",
        REWRITE,
      );
  }
  for (const reader of task.readers ?? []) {
    const problem = readerProblem(reader, target);
    if (problem !== undefined)
      throw refuse(
        `Reader ${JSON.stringify(reader.id)} ${problem}.`,
        "task",
        REWRITE,
      );
  }
};

/** The readers' views at the end, as retained, and at the seed, as the bundle ships it: the app's own headless mode on those bytes. */
const readersAtEnds = async (
  task: DesktopTask,
  target: TaskTarget,
): Promise<TaskViews> => {
  const readers = task.readers ?? [];
  if (readers.length === 0) return { seed: new Map(), end: new Map() };
  const end = await target.readerViews(readers, "end");
  return { seed: await target.readerViews(readers, "seed"), end };
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

/** Admit a screen-judged task: no file shows the change, and the build's seed and end screenshots ship as the judge's examples. */
const admitScreenTask = async (
  task: DesktopTask,
  target: TaskTarget,
  views: TaskViews,
): Promise<AdmittedTask> => {
  // Only a file the app owns could take a check instead; the export refuses the rest.
  const owned = (all: ReadonlyMap<string, TaskFileView>) =>
    new Map([...all].filter(([file]) => isWithinAny(file, target.paths)));
  const changed = readableChanges(owned(views.seed), owned(views.end));
  if (changed.length > 0)
    throw refuse(
      `A screen_judge judges state no file shows, but ${changed.join(", ")} changed between the seed and the end in a way a check can read.`,
      "task",
      `Check what changed in those files instead; ${DRAFT}.`,
    );
  const [seed, end] = await Promise.all([
    target.screens("seed"),
    target.screens("end"),
  ]);
  if (seed === undefined || end === undefined)
    throw refuse(
      `A screen_judge needs the screenshots a build computer takes at the seed and end checkpoints, its judge's examples, and the capture has no ${seed === undefined ? "seed" : "end"} screenshot.`,
      "task",
      "Capture the app in a build computer, marking seed and end there, and export from it.",
    );
  if (seed === "too-large" || end === "too-large")
    throw refuse(
      `The ${seed === "too-large" ? "seed" : "end"} screenshot is larger than the ${String(SCREEN_EXAMPLE_MAX_BYTES / 1024 / 1024)} MiB a judge's example may take.`,
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
      failing_on_seed: [],
    },
    limitations: [
      ...(namesApp(task.prompt, target)
        ? []
        : [
            `The task's prompt does not name the app (${target.title}), so start it with "In ${target.title}, ".`,
          ]),
      "The export judges no screen, so it did not check the screen_judge questions on the seed and the end: the witness does, running the bundle's own judge on a fresh screenshot at each stage, which needs a model endpoint.",
    ],
    readme: screenReadme(task, target.name),
    files: [
      {
        path: `tasks/${task.name}.json`,
        content: renderTaskSteps(task, target.name),
      },
      {
        path: `artifacts/${taskVerifierArtifact(task)}/verify.py`,
        content: renderTaskVerifier(task, target.name, examples),
      },
      { path: `evals/${target.name}.toml`, content: renderTaskEval([task]) },
    ],
  };
};

/** Read, validate and render the task a caller passed with the export, if any. */
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

export const admitDesktopTask = async (
  paths: readonly string[],
  target: TaskTarget,
  signal: AbortSignal | undefined,
): Promise<AdmittedTask | undefined> => {
  if (paths.length > 1)
    throw refuse(
      `${String(paths.length)} task files were given; a capture yields one task.`,
      "task",
      "Pass --task once, with the task written for this capture.",
    );
  const [path] = paths;
  if (path === undefined) return undefined;
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
  const task = parsed.value;
  const captured: TaskViews = {
    seed: capturedViewsAt(target, "seed"),
    end: capturedViewsAt(target, "end"),
  };
  const views: TaskViews = {
    seed: shippedSeedViews(target, captured.seed),
    end: captured.end,
  };
  refuseTargetProblems(task, target, views);
  if (isScreenTask(task)) return admitScreenTask(task, target, captured);
  const read = await readersAtEnds(task, target);
  const end = evaluateTaskChecks(task.checks, views.end, read.end);
  const failing = end.find((outcome) => !outcome.passed);
  if (failing !== undefined) {
    const check = task.checks.find(({ id }) => id === failing.id);
    throw refuse(
      `Check ${JSON.stringify(failing.id)} fails on the captured end state: ${failing.description}${check === undefined ? "" : readerRead(check, read.end)}.`,
      "task",
      `Write checks that the captured end state passes; ${DRAFT}.`,
    );
  }
  const seed = evaluateTaskChecks(task.checks, views.seed, read.seed).filter(
    (outcome) => !outcome.passed,
  );
  if (seed.length === 0)
    throw refuse(
      "Every check already passes on the seed, so the task would be done before the agent starts.",
      "task",
      "Add a check that the change the user made is needed for.",
    );
  // Only a failure on what the seed's view shows proves the task is not done yet.
  const failingOnSeed = seed
    .filter((outcome) => outcome.undecided !== true)
    .map((outcome) => outcome.id);
  if (failingOnSeed.length === 0)
    throw refuse(
      `No check fails on what the seed's views show: each failure there may come from a view that could not be read or is cut short (${seed
        .map(({ id, description }) => `${JSON.stringify(id)}: ${description}`)
        .join("; ")}).`,
      "task",
      `Add a check that fails on what the seed's views hold, such as a line or row of a file read whole; ${DRAFT}.`,
    );
  return {
    summary: {
      name: task.name,
      checks: task.checks.length,
      failing_on_seed: failingOnSeed,
    },
    limitations: namesApp(task.prompt, target)
      ? []
      : [
          `The task's prompt does not name the app (${target.title}): a solving agent's own shell cannot see the computer's files, and the app's name sends it to the screen, so start the prompt with "In ${target.title}, ".`,
        ],
    readme: taskReadme(task, target.name, failingOnSeed),
    files: [
      {
        path: `tasks/${task.name}.json`,
        content: renderTaskSteps(task, target.name),
      },
      {
        path: `artifacts/${taskVerifierArtifact(task)}/verify.py`,
        content: renderTaskVerifier(task, target.name),
      },
      { path: `evals/${target.name}.toml`, content: renderTaskEval([task]) },
    ],
  };
};
