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

const OPERATION = "export_desktop_application";
const REWRITE = "Fix the task file and export again.";
/** Where the change shows on either path: a capture inside a build computer cannot be described with the CLI, so its draft comes from stop_build_capture. */
const DRAFT =
  "each changed file's values in the task draft (describe-desktop-application-task, or stop_build_capture on a build computer) show what it held at the seed and at the end, at the pointer a check names it by";

/** What the export knows of the app: its name, owned paths, captured home, host identity, state files by home path and the checkpoints it reads. */
type TaskTarget = Pick<
  DesktopAppExportPlan,
  "name" | "paths" | "capturedHome"
> & {
  readonly files: ReadonlyMap<string, DesktopStatePath>;
  readonly identity: HostIdentity;
  readonly ends: StateEnds;
  /** Views of the text seeds the export rewrites, as it ships them. */
  readonly seedViews: ReadonlyMap<string, TaskFileView>;
  /** Home paths the bundle actually ships, including files that are not text. */
  readonly seeded: ReadonlySet<string>;
};

/** A task the capture validated: the files it adds to the bundle, its README section and its summary. */
export interface AdmittedTask {
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly readme: string;
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

/** Views of every file at the end checkpoint, or at the seed as the bundle ships it. */
const viewsAt = (
  target: TaskTarget,
  end: keyof StateEnds,
): ReadonlyMap<string, TaskFileView> => {
  const views = new Map<string, TaskFileView>();
  for (const [home, path] of target.files) {
    const version = versionAt(path, target.ends[end]);
    // A file not retained at the seed is not seeded, so the computer starts without it.
    if (end === "seed" && version?.present === true && version.sha256 === null)
      continue;
    const captured = version === undefined ? undefined : versionView(version);
    const view =
      end === "seed"
        ? shippedSeedCheckView(
            target.seeded.has(home),
            target.seedViews.get(home),
            captured,
          )
        : captured;
    if (view !== undefined) views.set(home, view);
  }
  return views;
};

const taskReadme = (
  task: DesktopTask,
  app: string,
  failingOnSeed: readonly string[],
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

REA kept the task because its checks fail on the seed (${failingOnSeed.map((id) => `\`${id}\``).join(", ")}) and all
pass on the captured end state.

To measure a solve rate, run the task k times (3 by default) with the agent and model to measure, and count the runs
whose summary line says \`passed\`; a run that says \`failed\` did not finish and is run again rather than counted:

    agent-env run <this folder> --task ${task.name} --agent claude-code --model MODEL
`;

/** Read, validate and render the task a caller passed with the export, if any. */
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
  const views: TaskViews = {
    seed: viewsAt(target, "seed"),
    end: viewsAt(target, "end"),
  };
  for (const check of task.checks) {
    const problem = targetProblem(check, target, views);
    if (problem !== undefined)
      throw refuse(
        `Check ${JSON.stringify(check.id)} ${problem}.`,
        "task",
        REWRITE,
      );
  }
  const end = evaluateTaskChecks(task.checks, views.end);
  const failing = end.find((outcome) => !outcome.passed);
  if (failing !== undefined)
    throw refuse(
      `Check ${JSON.stringify(failing.id)} fails on the captured end state: ${failing.description}.`,
      "task",
      `Write checks that the captured end state passes; ${DRAFT}.`,
    );
  const seed = evaluateTaskChecks(task.checks, views.seed).filter(
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
