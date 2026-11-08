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
import type {
  AgentEnvComputer,
  RecordingManifest,
} from "../../desktop/AgentEnvComputer.js";
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

/** A recording fetch that can resume after the manifest is known. */
type RecordingFetch =
  | {
      readonly ok: true;
      readonly recording: Exclude<Recording, { error: string }>;
      readonly segments: readonly Segment[];
    }
  | {
      readonly ok: false;
      readonly error: string;
      readonly manifest?: RecordingManifest;
    };

/**
 * End the recording and bring its segments back. A failure before the
 * manifest leaves nothing to resume; a failure after it keeps the manifest
 * so the next try only fetches the segments.
 */
const fetchRecording = async (
  computer: RecordedComputer,
  recordingId: string,
  pending: RecordingManifest | undefined,
  signal: AbortSignal,
): Promise<RecordingFetch> => {
  let manifest = pending;
  try {
    manifest ??= await computer.endRecording(recordingId, signal);
  } catch (cause: unknown) {
    return { ok: false, error: errorText(cause) };
  }
  try {
    const segments = await computer.recordingSegments(manifest, signal);
    return {
      ok: true,
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
    return { ok: false, error: errorText(cause), manifest };
  }
};

/** Write the recording's segments and the record's Evidence into the witness folder. */
const writeRecordFolder = async (
  directory: string,
  files: readonly { readonly path: string; readonly bytes: Buffer }[],
  evidence: Evidence,
  signal: AbortSignal,
): Promise<
  | undefined
  | { readonly published: false; readonly error: AnalysisError }
  | {
      readonly published: true;
      readonly error: AnalysisError;
      readonly release: () => Promise<void>;
    }
> => {
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
      : {
          published: true,
          error: writtenWithOpenHandles(
            {
              provider: AGENTENV_PROVIDER,
              operation: CHECK,
              what: "witness record",
            },
            directory,
            unclosed,
            evidence,
          ),
          release: () => unclosed.lease.release(),
        };
  } catch (cause: unknown) {
    return {
      published: false,
      error:
        cause instanceof AnalysisError
          ? cause
          : new ProviderAdapterError(AGENTENV_PROVIDER, CHECK, {
              userMessage: `The witness record could not be written: ${errorText(cause)}`,
              cause,
              partialObservation: evidence,
            }),
    };
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

/** How a witness write ended: saved, retryable, or published with cleanup still open. */
export type WitnessWrite =
  | { readonly kind: "saved"; readonly record: WitnessRecord }
  | {
      readonly kind: "retry";
      readonly error: AnalysisError;
      readonly manifest?: RecordingManifest;
    }
  | {
      readonly kind: "published";
      readonly record: WitnessRecord;
      readonly error: AnalysisError;
      readonly release: () => Promise<void>;
    };

/**
 * End the witness's recording, fetch it, and write the segments and
 * `witness.json`, the record as Evidence, into the witness folder. A
 * recording that has not been fetched is not written, so the next try can
 * resume it. A published folder whose handles fail to close is returned with
 * the record and the cleanup to retry.
 */
export const writeWitnessRecord = async (
  computer: RecordedComputer,
  witness: EndedWitness,
  log: Pick<ReadonlyActionLog, "entries" | "dropped">,
  {
    signal,
    redact = (value) => value,
    pendingManifest,
  }: {
    readonly signal: AbortSignal;
    /** Puts each known secret's handle in place of its value in what the record holds. */
    readonly redact?: (value: JsonValue) => JsonValue;
    readonly pendingManifest?: RecordingManifest | undefined;
  },
): Promise<WitnessWrite> => {
  const actions = log.entries.map(
    ({ truncated_arguments: cut, ...entry }): RecordedAction =>
      cut === undefined ? entry : { ...entry, truncated_arguments: [...cut] },
  );
  const dropped = log.dropped;
  const fetched = await fetchRecording(
    computer,
    witness.recordingId,
    pendingManifest,
    signal,
  );
  if (!fetched.ok)
    return {
      kind: "retry",
      ...(fetched.manifest === undefined ? {} : { manifest: fetched.manifest }),
      error: new ProviderAdapterError(AGENTENV_PROVIDER, CHECK, {
        userMessage: `The witness recording could not be saved: ${fetched.error}. Check this stage again to retry it.`,
        cause: new Error(fetched.error),
      }),
    };
  const { recording, segments } = fetched;
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
  const record = {
    path: join(witness.directory, RECORD),
    evidence_id: evidence.evidence_id,
    ...result,
  };
  if (unwritten === undefined) return { kind: "saved", record };
  if (unwritten.published)
    return {
      kind: "published",
      record,
      error: unwritten.error,
      release: unwritten.release,
    };
  return { kind: "retry", error: unwritten.error };
};
