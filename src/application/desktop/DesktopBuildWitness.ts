import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

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
  renderTaskSteps,
  renderTaskVerifier,
  taskVerifierArtifact,
} from "../../domain/desktop/appTaskPython.js";
import {
  admitWitnessStage,
  appStateViews,
  stageExpectation,
  stageVerdict,
  unrestoredChecks,
  unreadResetChecks,
  WITNESS_STAGES,
  type WitnessStage,
  type WitnessStageRecord,
} from "../../domain/desktop/buildWitness.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok, type Result } from "../../domain/result.js";
import { safeParseUtf8Json } from "../../domain/safeJson.js";
import type {
  AgentEnvComputer,
  RecordingManifest,
} from "../../desktop/AgentEnvComputer.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import { readHostFile } from "../../desktop/HostFileRead.js";
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

/** The most bytes REA reads of each of the bundle's files for the task. */
const BUNDLE_FILE_BYTES = 1024 * 1024;
const stepsSchema = z.array(
  z.looseObject({ type: z.string(), env_id: z.string().optional() }),
);

/** Why the bundle's steps and verifier for the task are not what the export writes for it; undefined when they are. */
const bundleTaskDifference = async (
  bundle: string,
  task: DesktopTask,
  signal: AbortSignal,
): Promise<string | undefined> => {
  const stepsPath = `tasks/${task.name}.json`;
  const verifierPath = `artifacts/${taskVerifierArtifact(task)}/verify.py`;
  const [steps, verifier] = await Promise.all(
    [stepsPath, verifierPath].map((path) =>
      readHostFile(join(bundle, path), BUNDLE_FILE_BYTES, signal),
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
  return verifier.toString("utf8") === renderTaskVerifier(task, app)
    ? undefined
    : `the bundle's ${verifierPath} differs from this task's checks.`;
};

/**
 * A witness from its seed on: `open` while stages are checked, `saving`
 * once a stage ended it and until its record is written, which a repeat of
 * that stage's check retries, and `saved` after, with the record a repeat
 * returns again.
 */
interface OpenWitness extends EndedWitness {
  state: "open" | "saving" | "saved";
  record?: WitnessRecord;
  /** A manifest whose segments still need to be fetched. */
  pendingManifest?: RecordingManifest | undefined;
  /** Close the published record's handles again, without rewriting it. */
  release?: (() => Promise<void>) | undefined;
  /**
   * The error from the publish whose handles are still open. A later cleanup
   * failure returns this same error, so the record and the cleanup lease stay
   * bound to it.
   */
  publishedError?: AnalysisError | undefined;
}

/** What the witness says of one filed stage. */
const summaryOf = (
  filed: WitnessStageRecord,
  next: WitnessStage | null,
  record: WitnessRecord | null,
): WitnessSummary => ({
  stage: filed.stage,
  expectation: filed.expectation,
  held: filed.held,
  status: !filed.held ? "failed" : record === null ? "open" : "held",
  next_stage: next,
  record,
});

/** The pass and fail counts of one set of results. */
const counted = (task: DesktopTask, results: TaskCheckOutcome[]) => {
  const passed = results.filter((result) => result.passed).length;
  return { task: task.name, passed, failed: results.length - passed, results };
};

/**
 * Grades an exported task against a build computer's app, as the bundle's
 * verifier does, and witnesses it: the seed, the edit, a near miss and the
 * seed again after a reset, recorded, with the action log, as Evidence.
 */
/**
 * Retry closing a published witness. A further failure returns the original
 * error, which already carries the record and the cleanup lease.
 */
export const retryPublishedCleanup = async (
  published: AnalysisError,
  release: () => Promise<void>,
): Promise<Result<void, AnalysisError>> => {
  try {
    await release();
    return ok(undefined);
  } catch {
    return err(published);
  }
};

export class DesktopBuildWitness {
  #witness: OpenWitness | undefined;
  /**
   * The request id of this computer's one witness recording, fixed before any
   * start is sent: a seed retried after a lost reply asks for the same id,
   * and the computer answers the recording it already began.
   */
  readonly #recordingRequest = `rea-witness:${randomUUID()}`;

  /** `bundle` is the folder the computer was started from, if it was; the witness takes only the task it holds. */
  constructor(
    private readonly computer: WitnessedComputer,
    private readonly actions: ReadonlyActionLog,
    private readonly bundle?: string,
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
    if (stage !== undefined && this.#witness?.state === "saving")
      return this.#resave(this.#witness, task, stage, signal);
    const saved =
      stage === undefined
        ? undefined
        : this.#savedAgain(task, stage, input.directory);
    if (saved !== undefined) return saved;
    const admitted =
      stage === undefined
        ? undefined
        : await this.#admit(task, stage, input.directory, signal);
    if (admitted?.ok === false) return admitted;
    const graded = await this.#grade(task, signal);
    if (!graded.ok) return graded;
    const results = graded.value;
    const checked = counted(task, results);
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

  /**
   * File a stage's results; one that does not hold, or the last, ends the
   * witness and writes its record. One its checks leave undecided files
   * nothing and can be checked again.
   */
  async #file(
    stage: WitnessStage,
    actionsBefore: number,
    results: TaskCheckOutcome[],
    signal: AbortSignal,
  ): Promise<Result<WitnessSummary, AnalysisError>> {
    const witness = this.#witness;
    if (witness === undefined) throw new TypeError("the stage was admitted");
    const verdict = stageVerdict(stage, results, witness.stages);
    if (verdict === "undecided") {
      const unreadSeed =
        stage === "after_reset"
          ? unreadResetChecks(witness.stages, results).map(
              (result) => result.id,
            )
          : [];
      return err(
        refused(
          `The checks cannot decide ${stage}: each failure that would settle it may come from a view that could not be read or is cut short (${[
            ...results.flatMap((result) =>
              result.undecided === true ? [result.description] : [],
            ),
            ...unreadSeed.map(
              (id) => `${id} could not be compared with the seed`,
            ),
          ].join("; ")}). Nothing was filed.`,
          `Check ${stage} again once the app's files read whole; a view that is always cut short or unreadable needs a task whose checks read other files.`,
        ),
      );
    }
    const held = verdict === "held";
    const unrestored =
      stage === "after_reset" && !held
        ? unrestoredChecks(witness.stages, results).map((result) => result.id)
        : [];
    const filed: WitnessStageRecord = {
      stage,
      actions_before: actionsBefore,
      checked_at: new Date().toISOString(),
      expectation: stageExpectation(stage),
      held,
      results,
      ...(unrestored.length === 0
        ? {}
        : {
            remediation: `The reset did not restore the seed: ${unrestored.join(", ")} came out unlike on the seed. Find what the app's data/reset leaves changed, export again and witness a fresh computer of the new bundle.`,
          }),
    };
    witness.stages.push(filed);
    if (held && stage !== WITNESS_STAGES.at(-1))
      return ok(
        summaryOf(filed, WITNESS_STAGES[witness.stages.length] ?? null, null),
      );
    witness.state = "saving";
    return this.#save(witness, filed, signal);
  }

  /** Write the ended witness's record; until that succeeds the witness keeps every stage for a retry. */
  async #save(
    witness: OpenWitness,
    filed: WitnessStageRecord,
    signal: AbortSignal,
  ): Promise<Result<WitnessSummary, AnalysisError>> {
    if (witness.record !== undefined && witness.release !== undefined) {
      const published = witness.publishedError;
      const released =
        published === undefined
          ? await witness
              .release()
              .then(() => ok(undefined))
              .catch((cause: unknown) =>
                err(
                  new ProviderAdapterError(
                    AGENTENV_PROVIDER,
                    "check_build_task",
                    {
                      userMessage: `The witness record was written to ${witness.directory} and is complete, but its output handles could not be closed: ${errorText(cause)}.`,
                      cause,
                    },
                  ),
                ),
              )
          : await retryPublishedCleanup(published, witness.release);
      if (!released.ok) return released;
      witness.release = undefined;
      witness.publishedError = undefined;
      witness.state = "saved";
      return ok(summaryOf(filed, null, witness.record));
    }
    const written = await writeWitnessRecord(
      this.computer,
      witness,
      this.actions,
      signal,
      witness.pendingManifest,
    );
    if (written.kind === "retry") {
      if (written.manifest !== undefined)
        witness.pendingManifest = written.manifest;
      return err(written.error);
    }
    witness.pendingManifest = undefined;
    witness.record = written.record;
    if (written.kind === "published") {
      witness.release = written.release;
      witness.publishedError = written.error;
      return err(written.error);
    }
    witness.state = "saved";
    return ok(summaryOf(filed, null, written.record));
  }

  /**
   * The saved witness again, for a repeat of the check that ended it with the
   * same task, such as after a cancelled call whose record was saved anyway;
   * undefined for any other check.
   */
  #savedAgain(
    task: DesktopTask,
    stage: WitnessStage,
    directory: string | undefined,
  ): Result<CheckedTask, AnalysisError> | undefined {
    const witness = this.#witness;
    const filed = witness?.stages.at(-1);
    if (
      witness?.record === undefined ||
      filed?.stage !== stage ||
      taskDigest(task) !== witness.digest
    )
      return undefined;
    // A folder the record was not saved to gets nothing written, so it is refused.
    if (directory !== undefined && directory !== witness.directory)
      return err(
        refused(
          `This witness's record was saved to ${witness.directory}, not ${directory}.`,
          "Ask again without directory or with the folder it was saved to; another witness needs a fresh computer.",
        ),
      );
    return ok({
      ...counted(task, filed.results),
      witness: summaryOf(filed, null, witness.record),
    });
  }

  /** Repeat the check of the stage that ended the witness to retry writing its record, without checking again. */
  async #resave(
    witness: OpenWitness,
    task: DesktopTask,
    stage: WitnessStage,
    signal: AbortSignal,
  ): Promise<Result<CheckedTask, AnalysisError>> {
    const filed = witness.stages.at(-1);
    if (
      filed === undefined ||
      filed.stage !== stage ||
      taskDigest(task) !== witness.digest
    )
      return err(
        refused(
          "This witness has ended, but its record is not saved yet.",
          `Check ${filed?.stage ?? "the last stage"} again with the same task to save it.`,
        ),
      );
    const saved = await this.#save(witness, filed, signal);
    return saved.ok
      ? ok({ ...counted(task, filed.results), witness: saved.value })
      : saved;
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
    const unfinished = this.#witness;
    if (unfinished !== undefined)
      return this.#retrySeed(unfinished, digest, directory);
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
    const differs =
      this.bundle === undefined
        ? undefined
        : await bundleTaskDifference(this.bundle, task, signal);
    if (differs !== undefined)
      return err(
        refused(
          `The task is not the bundle's ${task.name} task: ${differs}`,
          "Give the task exactly as export_build_environment took it for this bundle.",
        ),
      );
    try {
      const { recording_id: recordingId } = await this.computer.startRecording(
        this.#recordingRequest,
        signal,
      );
      const witness: OpenWitness = {
        task,
        digest,
        directory,
        recordingId,
        stages: [],
        state: "open",
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

  /**
   * A seed whose check failed after the witness opened, such as on a failed
   * read of the app's state, is checked again with the same task and folder,
   * keeping the recording it began.
   */
  #retrySeed(
    witness: OpenWitness,
    digest: string,
    directory: string | undefined,
  ): Result<OpenWitness, AnalysisError> {
    if (witness.state !== "open" || witness.stages.length > 0)
      return err(refused("This computer was already witnessed.", FRESH));
    return witness.digest === digest && witness.directory === directory
      ? ok(witness)
      : err(
          refused(
            "A seed check for another task or folder opened this witness and did not finish.",
            "Check the seed again with the task and directory it was first given.",
          ),
        );
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
    if (witness.state !== "open")
      return err(refused("This witness has ended.", FRESH));
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
