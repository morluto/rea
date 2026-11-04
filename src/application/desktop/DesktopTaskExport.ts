import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import {
  parseDesktopTask,
  type DesktopTask,
  type DesktopTaskCheck,
} from "../../domain/desktop/appTask.js";
import {
  evaluateTaskChecks,
  namesXmlNamespace,
  versionView,
  type TaskFileView,
} from "../../domain/desktop/appTaskChecks.js";
import {
  renderTaskEval,
  renderTaskSteps,
  renderTaskVerifier,
  taskVerifierArtifact,
} from "../../domain/desktop/appTaskPython.js";
import type { DesktopAppExportPlan } from "../../domain/desktop/appExport.js";
import type { DesktopStatePath } from "../../domain/desktop/desktopState.js";
import { EvidenceFileError } from "../../domain/evidenceErrors.js";
import { isWithinAny } from "../../domain/desktop/desktopStateDiff.js";
import { isPortableBundleName } from "../environment/environmentBundle.js";
import { readJsonFile } from "../JsonFiles.js";
import { refuse } from "./DesktopExportInstall.js";

const OPERATION = "export_desktop_application";
const REWRITE = "Fix the task file and export again.";

/** What the export knows of the app: its name, owned paths, captured home and state files by home path. */
type TaskTarget = Pick<
  DesktopAppExportPlan,
  "name" | "paths" | "capturedHome"
> & {
  readonly files: ReadonlyMap<string, DesktopStatePath>;
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

const readTaskFile = async (path: string, signal: AbortSignal | undefined) => {
  const resources = new ArtifactResourceScope();
  try {
    const loaded = await readJsonFile(path, signal, resources, OPERATION);
    if (loaded.ok) return loaded.value;
    if (!(loaded.error instanceof EvidenceFileError)) throw loaded.error;
    throw refuse(
      `The task file ${path} could not be read (${loaded.error.reason}).`,
      "task",
      "Pass a JSON task file, such as the task describe-desktop-application-task drafts.",
    );
  } finally {
    await resources.close();
  }
};

/** Why a check cannot be validated against this app, or undefined. */
const targetProblem = (
  check: DesktopTaskCheck,
  target: TaskTarget,
): string | undefined => {
  if (!isWithinAny(check.file, target.paths))
    return `names ${check.file}, which is not under the app's owned paths (${target.paths.join(", ") || "none"}); data/get serves only those`;
  if (JSON.stringify(check).includes(target.capturedHome))
    return `names the captured home ${target.capturedHome}, which the computer's home replaces`;
  if (check.kind !== "value_equals" && check.kind !== "value_absent")
    return undefined;
  const versions = target.files.get(check.file)?.versions ?? [];
  if (versions.some((version) => version.format === "text"))
    return `points into ${check.file}, which is text; use lines_present, lines_absent or line_count`;
  return versions.some(
    (version) => version.format === "xml" && namesXmlNamespace(version.view),
  )
    ? `points into ${check.file}, whose XML uses namespaces the verifier names differently`
    : undefined;
};

/** Views of every file at one end of the capture: its first or its last version. */
const viewsAt = (
  files: ReadonlyMap<string, DesktopStatePath>,
  end: "baseline" | "final",
): ReadonlyMap<string, TaskFileView> => {
  const views = new Map<string, TaskFileView>();
  for (const [home, path] of files) {
    const version =
      end === "baseline" ? path.versions[0] : path.versions.at(-1);
    // A file not retained at the baseline is not seeded, so the computer starts without it.
    if (
      end === "baseline" &&
      version?.present === true &&
      version.sha256 === null
    )
      continue;
    const view = version === undefined ? undefined : versionView(version);
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
no model. \`evals/${app}.toml\` names it, so a run of the bundle runs it.

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
  for (const check of task.checks) {
    const problem = targetProblem(check, target);
    if (problem !== undefined)
      throw refuse(
        `Check ${JSON.stringify(check.id)} ${problem}.`,
        "task",
        REWRITE,
      );
  }
  const end = evaluateTaskChecks(task.checks, viewsAt(target.files, "final"));
  const failing = end.find((outcome) => !outcome.passed);
  if (failing !== undefined)
    throw refuse(
      `Check ${JSON.stringify(failing.id)} fails on the captured end state: ${failing.description}.`,
      "task",
      "Write checks that the captured end state passes; describe-desktop-application-task shows its views.",
    );
  const failingOnSeed = evaluateTaskChecks(
    task.checks,
    viewsAt(target.files, "baseline"),
  )
    .filter((outcome) => !outcome.passed)
    .map((outcome) => outcome.id);
  if (failingOnSeed.length === 0)
    throw refuse(
      "Every check already passes on the seed, so the task would be done before the agent starts.",
      "task",
      "Add a check that the change the user made is needed for.",
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
