import { z } from "zod";
import { jsonValueSchema } from "./jsonValue.js";

import { normalizationSchema } from "./processScenario.js";
import { collectProcessCaptureIssues } from "./processCaptureValidation.js";

export * from "./processScenario.js";

/** Normalized raw PTY chunk, preserving transport-level output differences. */
export interface TerminalFrame {
  readonly sequence: number;
  readonly at_ms: number;
  readonly data: string;
}

/** Serialized terminal state after interpreting control and resize sequences. */
export interface RenderedTerminalFrame {
  readonly sequence: number;
  readonly at_ms: number;
  readonly columns: number;
  readonly rows: number;
  readonly cursor_x: number;
  readonly cursor_y: number;
  readonly active_buffer: "normal" | "alternate";
  readonly lines: readonly string[];
  readonly serialized_state: string;
}

/** Scheduled terminal interaction with its observed dispatch outcome. */
export interface InteractionEvent {
  readonly sequence: number;
  readonly scheduled_at_ms: number;
  readonly dispatched_at_ms: number;
  readonly type: "input" | "resize" | "signal";
  readonly data: string;
  readonly outcome: "dispatched" | "target_exited" | "failed";
}

/** One filesystem state used for before/after comparison. */
interface FileStateIdentity {
  readonly path: string;
  readonly mode: number;
  readonly size: number;
}

export type FileState = FileStateIdentity &
  (
    | {
        readonly type: "file";
        readonly sha256: string | null;
        readonly symlink_target: null;
      }
    | {
        readonly type: "symlink";
        readonly sha256: null;
        readonly symlink_target: string;
      }
    | {
        readonly type: "directory" | "other";
        readonly sha256: null;
        readonly symlink_target: null;
      }
  );

interface FileEffectIdentity {
  readonly path: string;
}

type FileEffect = FileEffectIdentity &
  (
    | {
        readonly status: "created";
        readonly before: null;
        readonly after: FileState;
      }
    | {
        readonly status: "deleted";
        readonly before: FileState;
        readonly after: null;
      }
    | {
        readonly status: "modified" | "unchanged";
        readonly before: FileState;
        readonly after: FileState;
      }
  );

/** A sampled owned-process observation; sampling cannot prove syscall completeness. */
export interface ProcessSample {
  readonly at_ms: number;
  readonly pid: number;
  readonly parent_pid: number;
  readonly command: string;
  readonly process_group_id: number | null;
  readonly session_id: number | null;
}

/** Initial or final filesystem snapshot selected for observation. */
export interface FilesystemCheckpoint {
  readonly name: string;
  readonly at_ms: number;
  readonly files: readonly FileState[];
  readonly effects: readonly FileEffect[];
  readonly truncated: boolean;
}

/** Capture collection whose members participate in global observation order. */
export const PROCESS_CAPTURE_EVENT_COLLECTIONS = [
  "frames",
  "rendered_frames",
  "interaction_events",
  "lifecycle",
  "process_samples",
  "filesystem_checkpoints",
] as const;

export type ProcessCaptureEventCollection =
  (typeof PROCESS_CAPTURE_EVENT_COLLECTIONS)[number];

/** One reference from global observation order into a capture collection. */
export interface ProcessCaptureEventJournalEntry {
  readonly capture_order: number;
  readonly collection: ProcessCaptureEventCollection;
  readonly index: number;
}

/** Shared observation callback used by every process-capture producer. */
export type RecordProcessCaptureEvent = (
  collection: ProcessCaptureEventCollection,
  index: number,
) => void;

/** Observed process-tree settlement and the cleanup required by that state. */
export type ProcessSettlement =
  | {
      readonly state: "quiesced";
      readonly elapsed_ms: number;
      readonly cleanup_outcome: "not_required";
    }
  | {
      readonly state: "alive_at_deadline" | "unverifiable";
      readonly elapsed_ms: number;
      readonly cleanup_outcome: "cleaned" | "failed";
    };

/**
 * Process capture observation set.
 *
 * `truncated` and `residual_unknowns` are semantic evidence: consumers must not
 * infer equivalence from matching bounded observations when either is present.
 */
export interface UnverifiedProcessCapture {
  readonly manifest: {
    readonly rea_version: string;
    readonly provider_version: string;
    readonly platform: string;
    readonly architecture: string;
    readonly pty_backend: "node-pty";
    readonly started_at: string;
    readonly completed_at: string;
    readonly scenario: Readonly<Record<string, unknown>>;
    readonly comparison_contract: Readonly<Record<string, unknown>>;
    readonly full_scenario_sha256: string;
    readonly comparison_contract_sha256: string;
    readonly executable_sha256: string;
    readonly normalization_sha256: string;
  };
  readonly normalization: z.infer<typeof normalizationSchema>;
  readonly frames: readonly TerminalFrame[];
  readonly rendered_frames: readonly RenderedTerminalFrame[];
  readonly interaction_events: readonly InteractionEvent[];
  readonly exit: {
    readonly code: number | null;
    readonly signal: number | null;
    readonly reason: "exited" | "timeout" | "idle_timeout";
  };
  readonly settlement: ProcessSettlement;
  readonly process_samples: readonly ProcessSample[];
  readonly filesystem_checkpoints: readonly FilesystemCheckpoint[];
  /**
   * Global observation order across independently recorded collections.
   *
   * Absence is accepted for captures written before this journal existed.
   */
  readonly event_journal?: readonly ProcessCaptureEventJournalEntry[];
  readonly files_before: readonly FileState[];
  readonly files_after: readonly FileState[];
  readonly filesystem_effects: readonly FileEffect[];
  readonly truncated: boolean;
  readonly limitations: readonly string[];
  readonly residual_unknowns: readonly {
    readonly scope:
      | "terminal"
      | "interaction"
      | "exit"
      | "process"
      | "filesystem"
      | "cleanup"
      | "network"
      | "environment";
    readonly reason: string;
  }[];
  readonly cleanup: {
    readonly owned_process_group: "verified";
    readonly temporary_root: "removed";
  };
}

const fileStateShape = {
  path: z.string(),
  mode: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
};
const fileStateSchema = z.discriminatedUnion("type", [
  z.object({
    ...fileStateShape,
    type: z.literal("file"),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    symlink_target: z.null(),
  }),
  z.object({
    ...fileStateShape,
    type: z.literal("symlink"),
    sha256: z.null(),
    symlink_target: z.string(),
  }),
  z.object({
    ...fileStateShape,
    type: z.enum(["directory", "other"]),
    sha256: z.null(),
    symlink_target: z.null(),
  }),
]);
const fileEffectSchema = z.discriminatedUnion("status", [
  z.object({
    path: z.string(),
    status: z.literal("created"),
    before: z.null(),
    after: fileStateSchema,
  }),
  z.object({
    path: z.string(),
    status: z.literal("deleted"),
    before: fileStateSchema,
    after: z.null(),
  }),
  z.object({
    path: z.string(),
    status: z.enum(["modified", "unchanged"]),
    before: fileStateSchema,
    after: fileStateSchema,
  }),
]);
/** Exact serialized shape of a process capture. */
const processCaptureShapeSchema: z.ZodType<UnverifiedProcessCapture> =
  z.strictObject({
    manifest: z.strictObject({
      rea_version: z.string().min(1),
      provider_version: z.string().min(1),
      platform: z.string().min(1),
      architecture: z.string().min(1),
      pty_backend: z.literal("node-pty"),
      started_at: z.iso.datetime(),
      completed_at: z.iso.datetime(),
      scenario: z.record(z.string(), jsonValueSchema),
      comparison_contract: z.record(z.string(), jsonValueSchema),
      full_scenario_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      comparison_contract_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      executable_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      normalization_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
    normalization: normalizationSchema,
    frames: z.array(
      z.object({
        sequence: z.number().int().nonnegative(),
        at_ms: z.number().int().nonnegative(),
        data: z.string(),
      }),
    ),
    rendered_frames: z.array(
      z.object({
        sequence: z.number().int().nonnegative(),
        at_ms: z.number().int().nonnegative(),
        columns: z.number().int().positive(),
        rows: z.number().int().positive(),
        cursor_x: z.number().int().nonnegative(),
        cursor_y: z.number().int().nonnegative(),
        active_buffer: z.enum(["normal", "alternate"]),
        lines: z.array(z.string()),
        serialized_state: z.string(),
      }),
    ),
    interaction_events: z.array(
      z.object({
        sequence: z.number().int().nonnegative(),
        scheduled_at_ms: z.number().int().nonnegative(),
        dispatched_at_ms: z.number().int().nonnegative(),
        type: z.enum(["input", "resize", "signal"]),
        data: z.string(),
        outcome: z.enum(["dispatched", "target_exited", "failed"]),
      }),
    ),
    exit: z.object({
      code: z.number().int().nullable(),
      signal: z.number().int().nullable(),
      reason: z.enum(["exited", "timeout", "idle_timeout"]),
    }),
    settlement: z.discriminatedUnion("state", [
      z.object({
        state: z.literal("quiesced"),
        elapsed_ms: z.number().int().nonnegative(),
        cleanup_outcome: z.literal("not_required"),
      }),
      z.object({
        state: z.enum(["alive_at_deadline", "unverifiable"]),
        elapsed_ms: z.number().int().nonnegative(),
        cleanup_outcome: z.enum(["cleaned", "failed"]),
      }),
    ]),
    process_samples: z.array(
      z.object({
        at_ms: z.number().int().nonnegative(),
        pid: z.number().int().positive(),
        parent_pid: z.number().int().nonnegative(),
        command: z.string(),
        process_group_id: z.number().int().positive().nullable(),
        session_id: z.number().int().nonnegative().nullable(),
      }),
    ),
    filesystem_checkpoints: z.array(
      z.object({
        name: z.enum(["before", "after_settlement"]),
        at_ms: z.number().int().nonnegative(),
        files: z.array(fileStateSchema),
        effects: z.array(fileEffectSchema),
        truncated: z.boolean(),
      }),
    ),
    event_journal: z
      .array(
        z.object({
          capture_order: z.number().int().nonnegative(),
          collection: z.enum(PROCESS_CAPTURE_EVENT_COLLECTIONS),
          index: z.number().int().nonnegative(),
        }),
      )
      .default([]),
    files_before: z.array(fileStateSchema),
    files_after: z.array(fileStateSchema),
    filesystem_effects: z.array(fileEffectSchema),
    truncated: z.boolean(),
    limitations: z.array(z.string()),
    residual_unknowns: z.array(
      z.object({
        scope: z.enum([
          "terminal",
          "interaction",
          "exit",
          "process",
          "filesystem",
          "cleanup",
          "network",
          "environment",
        ]),
        reason: z.string(),
      }),
    ),
    cleanup: z.object({
      owned_process_group: z.literal("verified"),
      temporary_root: z.literal("removed"),
    }),
  });

/** Exact serialized shape plus all process-capture semantic invariants. */
export const processCaptureSchema = processCaptureShapeSchema.superRefine(
  (capture, context) => {
    for (const issue of collectProcessCaptureIssues(capture))
      context.addIssue({
        code: "custom",
        path: issue.path.split("."),
        message: issue.message,
      });
  },
);

export { parseProcessCapture } from "./processCaptureParsing.js";
export type { ProcessCapture } from "./processCaptureParsing.js";

export {
  compareProcessCaptures,
  comparisonStatusSchema,
  deriveProcessComparisonStatus,
  PROCESS_COMPARISON_DIMENSIONS,
  processCaptureComparisonSchema,
} from "./processComparison.js";
