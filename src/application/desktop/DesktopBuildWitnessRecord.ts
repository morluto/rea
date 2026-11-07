import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { DesktopTask } from "../../domain/desktop/appTask.js";
import type {
  WitnessStage,
  WitnessStageRecord,
} from "../../domain/desktop/buildWitness.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { err, ok, type Result } from "../../domain/result.js";
import type { AgentEnvComputer } from "../../desktop/AgentEnvComputer.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import {
  LOGGED_ACTIONS,
  LOGGED_BYTES,
  LOGGED_LIST_ITEMS,
  LOGGED_TEXT_BYTES,
  type BuildComputerAction,
  type ReadonlyActionLog,
} from "./DesktopBuildActionLog.js";
import { errorText } from "./DesktopBuildCommands.js";
import { DESKTOP_PROVIDER } from "./DesktopCaptureRefusals.js";
import {
  writeOutputTree,
  writtenWithOpenHandles,
} from "./DesktopOutputTree.js";

const CHECK = "check_build_task";
const RECORD = "witness.json";

/** The computer routes the witness record reads. */
export type RecordedComputer = Pick<
  AgentEnvComputer,
  "endRecording" | "recordingSegments"
>;

/** A logged action as the record keeps it: the log's entry, as JSON. */
type RecordedAction = Omit<BuildComputerAction, "truncated_arguments"> & {
  readonly truncated_arguments?: string[];
};

type Recording = WitnessRecord["recording"];
type Segment = { readonly path: string; readonly bytes: Buffer };

/** The witness record: each stage's checks, the actions between them and the recording. */
export type WitnessRecord = {
  readonly path: string;
  readonly evidence_id: string;
  readonly verdict: "held" | "failed";
  readonly failed_stage: WitnessStage | null;
  readonly task: { readonly name: string; readonly sha256: string };
  readonly stages: WitnessStageRecord[];
  readonly actions: RecordedAction[];
  /** How many of the earliest logged actions the log no longer keeps. */
  readonly actions_dropped: number;
  readonly recording:
    | {
        readonly recording_id: string;
        readonly segments: {
          readonly path: string;
          readonly bytes: number;
          readonly sha256: string;
        }[];
      }
    | { readonly error: string };
};

/** What the record is written from: the witnessed task, its stages and where its folder is. */
export interface EndedWitness {
  readonly task: DesktopTask;
  readonly digest: string;
  readonly directory: string;
  readonly recordingId: string;
  readonly stages: WitnessStageRecord[];
}

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** End the recording and bring its segments back, or say why they are missing. */
const endRecording = async (
  computer: RecordedComputer,
  recordingId: string,
  signal: AbortSignal,
): Promise<{
  readonly recording: Recording;
  readonly segments: readonly Segment[];
}> => {
  try {
    const manifest = await computer.endRecording(recordingId, signal);
    const segments = await computer.recordingSegments(manifest, signal);
    return {
      segments,
      recording: {
        recording_id: manifest.recording_id,
        segments: segments.map((segment) => ({
          path: join(
            "recording",
            segment.path.split("/").at(-1) ?? segment.path,
          ),
          bytes: segment.bytes.length,
          sha256: sha256(segment.bytes),
        })),
      },
    };
  } catch (cause: unknown) {
    return { segments: [], recording: { error: errorText(cause) } };
  }
};

/** Write the recording's segments and the record's Evidence into the witness folder. */
const writeRecordFolder = async (
  directory: string,
  files: readonly { readonly path: string; readonly bytes: Buffer }[],
  evidence: Evidence,
  signal: AbortSignal,
): Promise<AnalysisError | undefined> => {
  try {
    const unclosed = await writeOutputTree(
      directory,
      async (tree) => {
        for (const file of files)
          await tree.write(
            file.path,
            Readable.from([file.bytes]),
            { bytes: file.bytes.length, sha256: sha256(file.bytes) },
            signal,
          );
      },
      { operation: CHECK, field: "directory" },
      signal,
    );
    return unclosed === undefined
      ? undefined
      : writtenWithOpenHandles(
          {
            provider: AGENTENV_PROVIDER,
            operation: CHECK,
            what: "witness record",
          },
          directory,
          unclosed,
          evidence,
        );
  } catch (cause: unknown) {
    return cause instanceof AnalysisError
      ? cause
      : new ProviderAdapterError(AGENTENV_PROVIDER, CHECK, {
          userMessage: `The witness record could not be written: ${errorText(cause)}`,
          cause,
          partialObservation: evidence,
        });
  }
};

/** What the record's action log leaves out: its earliest actions, and parts of long arguments. */
const logLimitations = (
  actions: readonly RecordedAction[],
  dropped: number,
): string[] => [
  ...(dropped === 0
    ? []
    : [
        `The action log keeps the latest ${String(LOGGED_ACTIONS)} actions within ${String(LOGGED_BYTES / 1024)} KiB, so the ${String(dropped)} earliest are not in the record; the stages' rules counted them.`,
      ]),
  ...(actions.some((action) => action.truncated_arguments !== undefined)
    ? [
        `Arguments named in an action's truncated_arguments are cut in the record, each string to ${String(LOGGED_TEXT_BYTES)} bytes and each list to ${String(LOGGED_LIST_ITEMS)} items; the computer received them whole.`,
      ]
    : []),
];

/** Which stages graded files that had not settled by the bound, and which of them had a read cut there. */
const unsettledLimitation = (
  stages: readonly WitnessStageRecord[],
): string[] => {
  const named = (cut: boolean) =>
    stages.flatMap(({ stage, settled, read_cut }) =>
      settled || (cut && !read_cut) ? [] : [stage],
    );
  const [unsettled, cut] = [named(false), named(true)];
  return [
    ...(unsettled.length === 0
      ? []
      : [
          `The app's files had not held for the settle window by its bound when these stages were checked, so each graded its last completed read, with settled false: ${unsettled.join(", ")}.`,
        ]),
    ...(cut.length === 0
      ? []
      : [
          `A read still running at the settle bound was cut, with read_cut true, in: ${cut.join(", ")}.`,
        ]),
  ];
};

/**
 * End the witness's recording, fetch it, and write the segments and
 * `witness.json`, the record as Evidence, into the witness folder.
 */
export const writeWitnessRecord = async (
  computer: RecordedComputer,
  witness: EndedWitness,
  log: Pick<ReadonlyActionLog, "entries" | "dropped">,
  {
    signal,
    redact = (value) => value,
  }: {
    readonly signal: AbortSignal;
    /** Puts each known secret's handle in place of its value in what the record holds. */
    readonly redact?: (value: JsonValue) => JsonValue;
  },
): Promise<Result<WitnessRecord, AnalysisError>> => {
  const actions = log.entries.map(
    ({ truncated_arguments: cut, ...entry }): RecordedAction =>
      cut === undefined ? entry : { ...entry, truncated_arguments: [...cut] },
  );
  const dropped = log.dropped;
  const { recording, segments } = await endRecording(
    computer,
    witness.recordingId,
    signal,
  );
  const failed = witness.stages.find((stage) => !stage.held);
  const recorded = {
    verdict: failed === undefined ? ("held" as const) : ("failed" as const),
    failed_stage: failed?.stage ?? null,
    task: { name: witness.task.name, sha256: witness.digest },
    stages: witness.stages,
    actions,
    actions_dropped: dropped,
    recording,
  };
  // Redacting keeps every string a string, so the record keeps its shape.
  const result = redact(
    recorded as unknown as JsonValue,
  ) as unknown as typeof recorded;
  const evidence = createEvidence(undefined, DESKTOP_PROVIDER, {
    predicateType: "rea.desktop-build-witness",
    operation: CHECK,
    parameters: { task: result.task.name, stages: witness.stages.length },
    result: result as unknown as JsonValue,
    confidence: "observed",
    authority: "controlled-replay",
    limitations: [
      "Checks read the app's data/get views with REA's evaluator, as the exported verifier does; the verifier itself did not run.",
      ...("error" in recording
        ? [`The recording is missing: ${recording.error}`]
        : []),
      ...logLimitations(actions, dropped),
      ...unsettledLimitation(result.stages),
    ],
  });
  const files = [
    ...("segments" in recording
      ? recording.segments.flatMap((target, index) => {
          const bytes = segments[index]?.bytes;
          return bytes === undefined ? [] : [{ path: target.path, bytes }];
        })
      : []),
    {
      path: RECORD,
      bytes: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
    },
  ];
  const unwritten = await writeRecordFolder(
    witness.directory,
    files,
    evidence,
    signal,
  );
  if (unwritten !== undefined) return err(unwritten);
  return ok({
    path: join(witness.directory, RECORD),
    evidence_id: evidence.evidence_id,
    ...result,
  });
};
