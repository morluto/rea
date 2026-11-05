import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";

import type { z } from "zod";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  parseDesktopTask,
  type desktopTaskSchema,
  type DesktopTask,
} from "../../domain/desktop/appTask.js";
import {
  evaluateTaskChecks,
  type TaskCheckOutcome,
} from "../../domain/desktop/appTaskChecks.js";
import {
  admitWitnessStage,
  appStateViews,
  stageExpectation,
  stageHeld,
  WITNESS_STAGES,
  type WitnessStage,
} from "../../domain/desktop/buildWitness.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { AgentEnvComputer } from "../../desktop/AgentEnvComputer.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import { isPortableBundleName } from "../environment/environmentBundle.js";
import type { ReadonlyActionLog } from "./DesktopBuildActionLog.js";
import { errorText } from "./DesktopBuildCommands.js";
import {
  writeWitnessRecord,
  type EndedWitness,
  type WitnessRecord,
} from "./DesktopBuildWitnessRecord.js";

const CHECK = "check_build_task";
const FRESH =
  "Close this computer and start a fresh one from the bundle with start_build_computer.";

/** The computer routes the witness reads. */
export type WitnessedComputer = Pick<
  AgentEnvComputer,
  "appData" | "startRecording" | "endRecording" | "recordingSegments"
>;

type WitnessSummary = {
  readonly stage: WitnessStage;
  readonly expectation: "some_fail" | "all_pass";
  readonly held: boolean;
  readonly status: "open" | "held" | "failed";
  readonly next_stage: WitnessStage | null;
  readonly record: WitnessRecord | null;
};

/** One check of the task against the app's live state, and the witness stage it filed, if any. */
export type CheckedTask = {
  readonly task: string;
  readonly passed: number;
  readonly failed: number;
  readonly results: TaskCheckOutcome[];
  readonly witness: WitnessSummary | null;
};

const refused = (userMessage: string, remediationAction: string) =>
  new AnalysisInputError(CHECK, {
    userMessage,
    remediationAction,
    conformsToInputContract: true,
  });

const taskDigest = (task: DesktopTask) =>
  createHash("sha256").update(JSON.stringify(task)).digest("hex");

/** Whether a folder can take the record: absent, or empty. */
const usableFolder = async (directory: string): Promise<boolean> =>
  readdir(directory).then(
    (entries) => entries.length === 0,
    (cause: unknown) =>
      (cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT",
  );

interface OpenWitness extends EndedWitness {
  ended: boolean;
}

/**
 * Grades an exported task against a build computer's app, as the bundle's
 * verifier does, and witnesses it: the seed, the edit, a near miss and the
 * seed again after a reset, recorded, with the action log, as Evidence.
 */
export class DesktopBuildWitness {
  #witness: OpenWitness | undefined;

  constructor(
    private readonly computer: WitnessedComputer,
    private readonly actions: ReadonlyActionLog,
  ) {}

  async check(
    input: {
      readonly task: z.output<typeof desktopTaskSchema>;
      readonly stage?: WitnessStage | undefined;
      readonly directory?: string | undefined;
    },
    signal: AbortSignal,
  ): Promise<Result<CheckedTask, AnalysisError>> {
    const parsed = parseDesktopTask(input.task, isPortableBundleName);
    if (!parsed.ok)
      return err(
        refused(
          `The task is refused: ${parsed.error}`,
          "Pass the task as export_build_environment took it.",
        ),
      );
    const task = parsed.value;
    const { stage } = input;
    const admitted =
      stage === undefined
        ? undefined
        : await this.#admit(task, stage, input.directory, signal);
    if (admitted?.ok === false) return admitted;
    const graded = await this.#grade(task, signal);
    if (!graded.ok) return graded;
    const results = graded.value;
    const passed = results.filter((result) => result.passed).length;
    const checked = {
      task: task.name,
      passed,
      failed: results.length - passed,
      results,
    };
    if (stage === undefined || admitted === undefined)
      return ok({ ...checked, witness: null });
    const filed = await this.#file(stage, admitted.value, results, signal);
    return filed.ok ? ok({ ...checked, witness: filed.value }) : filed;
  }

  /** The task's checks against the app's live views, one result per check. */
  async #grade(
    task: DesktopTask,
    signal: AbortSignal,
  ): Promise<Result<TaskCheckOutcome[], AnalysisError>> {
    try {
      const views = appStateViews(
        await this.computer.appData("data/get", signal),
      );
      return views.ok
        ? ok([...evaluateTaskChecks(task.checks, views.value)])
        : err(
            refused(
              views.error,
              "Start the computer from a bundle export_build_environment wrote.",
            ),
          );
    } catch (cause: unknown) {
      return err(
        cause instanceof AnalysisError
          ? cause
          : new ProviderAdapterError(AGENTENV_PROVIDER, CHECK, {
              userMessage: `Reading the app's state failed: ${errorText(cause)}`,
              cause,
            }),
      );
    }
  }

  /** File a stage's results; one that does not hold, or the last, ends the witness and writes its record. */
  async #file(
    stage: WitnessStage,
    actionsBefore: number,
    results: TaskCheckOutcome[],
    signal: AbortSignal,
  ): Promise<Result<WitnessSummary, AnalysisError>> {
    const witness = this.#witness;
    if (witness === undefined) throw new TypeError("the stage was admitted");
    const held = stageHeld(stage, results);
    const expectation = stageExpectation(stage);
    witness.stages.push({
      stage,
      actions_before: actionsBefore,
      checked_at: new Date().toISOString(),
      expectation,
      held,
      results,
    });
    const ends = !held || stage === WITNESS_STAGES.at(-1);
    if (!ends)
      return ok({
        stage,
        expectation,
        held,
        status: "open",
        next_stage: WITNESS_STAGES[witness.stages.length] ?? null,
        record: null,
      });
    witness.ended = true;
    const record = await writeWitnessRecord(
      this.computer,
      witness,
      this.actions,
      signal,
    );
    if (!record.ok) return record;
    const status = held ? "held" : "failed";
    return ok({
      stage,
      expectation,
      held,
      status,
      next_stage: null,
      record: record.value,
    });
  }

  /** Open the witness at its seed, or admit the next stage of the open one; its value is where its actions end. */
  async #admit(
    task: DesktopTask,
    stage: WitnessStage,
    directory: string | undefined,
    signal: AbortSignal,
  ): Promise<Result<number, AnalysisError>> {
    const digest = taskDigest(task);
    const opened =
      stage === "seed"
        ? await this.#open(task, digest, directory, signal)
        : this.#continuing(digest, directory);
    if (!opened.ok) return opened;
    const admitted = admitWitnessStage(
      opened.value.stages,
      stage,
      this.actions,
    );
    return admitted.ok
      ? admitted
      : err(
          refused(
            admitted.error,
            "Do what the message says, then check this stage again.",
          ),
        );
  }

  /** Open the witness with its folder and begin its recording. */
  async #open(
    task: DesktopTask,
    digest: string,
    directory: string | undefined,
    signal: AbortSignal,
  ): Promise<Result<OpenWitness, AnalysisError>> {
    if (this.#witness !== undefined)
      return err(refused("This computer was already witnessed.", FRESH));
    if (directory === undefined)
      return err(
        refused(
          "The seed stage opens the witness and needs directory.",
          "Give directory, a new or empty folder on this host for the record and recording.",
        ),
      );
    if (!(await usableFolder(directory)))
      return err(
        refused(
          `${directory} exists and is not empty.`,
          "Give a new or empty folder.",
        ),
      );
    try {
      const { recording_id: recordingId } = await this.computer.startRecording(
        `rea-witness:${randomUUID()}`,
        signal,
      );
      const witness = {
        task,
        digest,
        directory,
        recordingId,
        stages: [],
        ended: false,
      };
      this.#witness = witness;
      return ok(witness);
    } catch (cause: unknown) {
      return err(
        new ProviderAdapterError(AGENTENV_PROVIDER, CHECK, {
          userMessage: `The witness could not start its recording: ${errorText(cause)}`,
          cause,
        }),
      );
    }
  }

  /** The open witness a later stage continues, for the same task and without a folder. */
  #continuing(
    digest: string,
    directory: string | undefined,
  ): Result<OpenWitness, AnalysisError> {
    const witness = this.#witness;
    if (witness === undefined)
      return err(
        refused(
          "No witness is open on this computer.",
          "Check the seed stage first, with directory.",
        ),
      );
    if (witness.ended) return err(refused("This witness has ended.", FRESH));
    if (directory !== undefined)
      return err(
        refused(
          "Only the seed stage takes directory.",
          "Leave directory out after the seed stage.",
        ),
      );
    return witness.digest === digest
      ? ok(witness)
      : err(
          refused(
            "This task differs from the one the seed stage checked.",
            "Give every stage the task the seed stage checked.",
          ),
        );
  }
}
