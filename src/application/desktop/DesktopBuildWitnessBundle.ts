import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { DesktopTask } from "../../domain/desktop/appTask.js";
import type { TaskCheckOutcome } from "../../domain/desktop/appTaskChecks.js";
import {
  renderTaskSteps,
  renderTaskVerifier,
  sameTaskVerifier,
  taskVerifierArtifact,
} from "../../domain/desktop/appTaskPython.js";
import {
  SCREEN_SETTLE_MS,
  isScreenTask,
  screenExamplesOf,
  type ScreenJudge,
} from "../../domain/desktop/appTaskScreen.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok, type Result } from "../../domain/result.js";
import { safeParseUtf8Json } from "../../domain/safeJson.js";
import {
  guestFileAnswerCeiling,
  guestFileAnswerWorkingBytes,
  type AgentEnvComputer,
} from "../../desktop/AgentEnvComputer.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import { readHostFile } from "../../desktop/HostFileRead.js";
import { errorText } from "./DesktopBuildCommands.js";

const CHECK = "check_build_task";

/** The bundle folder a witnessed computer was started from, and the judge that runs its screen judges. */
export interface WitnessBundle {
  readonly path: string;
  readonly judge?: ScreenJudge;
}

/** A task's results on the app's state, whether its files had settled, and whether the bound cut a read. */
export type Graded = {
  readonly results: TaskCheckOutcome[];
  readonly settled: boolean;
  readonly read_cut: boolean;
};

/**
 * The most bytes REA reads of each of the bundle's task files. A task the
 * export accepts has no smaller file cap, and the steps file holds the whole
 * prompt. The bound is the same working budget as a guest file answer: a
 * quarter of the heap, divided by the copies a read and a parse hold.
 */
const bundleFileBytes = () =>
  guestFileAnswerWorkingBytes(guestFileAnswerCeiling());
const stepsSchema = z.array(
  z.looseObject({ type: z.string(), env_id: z.string().optional() }),
);

/** Why the bundle's steps and verifier for the task are not what the export writes for it; undefined when they are. */
export const bundleTaskDifference = async (
  bundle: string,
  task: DesktopTask,
  signal: AbortSignal,
): Promise<string | undefined> => {
  const stepsPath = `tasks/${task.name}.json`;
  const verifierPath = `artifacts/${taskVerifierArtifact(task)}/verify.py`;
  const [steps, verifier] = await Promise.all(
    [stepsPath, verifierPath].map((path) =>
      readHostFile(join(bundle, path), bundleFileBytes(), signal),
    ),
  );
  if (!Buffer.isBuffer(steps) || !Buffer.isBuffer(verifier))
    return `the bundle at ${bundle} has no readable ${Buffer.isBuffer(steps) ? verifierPath : stepsPath}.`;
  const parsed = safeParseUtf8Json(steps);
  const listed = parsed.ok ? parsed.value : undefined;
  const app = stepsSchema
    .safeParse(listed)
    .data?.find((step) => step.type === "deploy_env")?.env_id;
  if (
    app === undefined ||
    !isDeepStrictEqual(listed, JSON.parse(renderTaskSteps(task, app)))
  )
    return `the bundle's ${stepsPath} differs from this task's steps.`;
  const source = verifier.toString("utf8");
  const differs = `the bundle's ${verifierPath} differs from this task's checks.`;
  if (!isScreenTask(task))
    return sameTaskVerifier(renderTaskVerifier(task, app), source)
      ? undefined
      : differs;
  // A screen judge's examples are the build's screenshots, which only the bundle holds.
  const examples = screenExamplesOf(source);
  if (examples === undefined)
    return `the bundle's ${verifierPath} holds no screen judge examples.`;
  return source === renderTaskVerifier(task, app, examples)
    ? undefined
    : differs;
};

/** A screen-judged task's checks on a fresh screenshot, each answered by the bundle's own judge. */
export const judgeScreenTask = async (
  computer: Pick<AgentEnvComputer, "callTool">,
  bundle: WitnessBundle | undefined,
  task: DesktopTask,
  signal: AbortSignal,
): Promise<Result<Graded, AnalysisError>> => {
  const judge = bundle?.judge;
  if (bundle === undefined || judge === undefined)
    return err(
      new AnalysisInputError(CHECK, {
        userMessage:
          "A screen_judge is checked by the bundle's own judge, so it needs a computer started from the bundle.",
        remediationAction:
          "Start a computer from the exported bundle with start_build_computer and check it there.",
        conformsToInputContract: true,
      }),
    );
  const results: TaskCheckOutcome[] = [];
  try {
    await delay(SCREEN_SETTLE_MS, undefined, { signal });
    const shot = await computer.callTool(
      "computer_screenshot",
      { format: "jpeg", quality: 70 },
      signal,
    );
    const image = shot.content.find((block) => block.type === "image")?.data;
    if (shot.isError || typeof image !== "string")
      throw new Error("the computer took no screenshot");
    const screen = Buffer.from(image, "base64");
    const verifier = join(
      bundle.path,
      "artifacts",
      taskVerifierArtifact(task),
      "verify.py",
    );
    for (const check of task.checks)
      if (check.kind === "screen_judge")
        results.push(await judge(verifier, check, screen, signal));
    return ok({ results, settled: true, read_cut: false });
  } catch (cause: unknown) {
    return err(
      cause instanceof AnalysisError
        ? results.length === 0
          ? cause
          : cause.retainDiagnostics({ completed_judge_checks: results })
        : new ProviderAdapterError(AGENTENV_PROVIDER, CHECK, {
            userMessage: `The screen judge could not check the screen: ${errorText(cause)}`,
            cause,
            ...(results.length === 0
              ? {}
              : { diagnostics: { completed_judge_checks: results } }),
          }),
    );
  }
};
