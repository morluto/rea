import { z } from "zod";
import { jsonValueSchema } from "./jsonValue.js";

import {
  LEGACY_PROCESS_CAPTURE_MESSAGE,
  normalizationSchema,
} from "./processScenario.js";

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

/** Scheduled input, resize, or signal with its observed dispatch outcome. */
export interface InteractionEvent {
  readonly sequence: number;
  readonly scheduled_at_ms: number;
  readonly dispatched_at_ms: number;
  readonly type: "input" | "resize" | "signal";
  readonly data: string;
  readonly outcome: "dispatched" | "target_exited" | "failed";
}

/** One filesystem state used for before/after comparison. */
export interface FileState {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly mode: number;
  readonly size: number;
  readonly sha256: string | null;
  readonly symlink_target: string | null;
}

interface FileEffect {
  readonly path: string;
  readonly status: "created" | "modified" | "deleted" | "unchanged";
  readonly before: FileState | null;
  readonly after: FileState | null;
}

/** A sampled owned-process observation; sampling cannot prove syscall completeness. */
export interface ProcessSample {
  readonly at_ms: number;
  readonly pid: number;
  readonly parent_pid: number;
  readonly command: string;
  readonly process_group_id: number | null;
  readonly session_id: number | null;
}

/** One bounded lifecycle transition for a proven owned process identity. */
export interface ProcessLifecycleEvent {
  readonly sequence: number;
  readonly at_ms: number;
  readonly type: "spawned" | "reparented" | "exited" | "signal_dispatched";
  readonly pid: number;
  readonly parent_pid: number | null;
  readonly previous_parent_pid: number | null;
  readonly signal: "SIGINT" | "SIGTERM" | "SIGKILL" | null;
}

/**
 * Named filesystem state whose effects are relative to the prior checkpoint.
 */
export interface FilesystemCheckpoint {
  readonly name: string;
  readonly at_ms: number;
  readonly files: readonly FileState[];
  readonly effects: readonly FileEffect[];
  readonly truncated: boolean;
}

/** Recorded deterministic dependency invocation and route-match outcome. */
export interface ShimEvent {
  readonly sequence: number;
  readonly at_ms: number;
  readonly command: string;
  readonly route_index: number | null;
  readonly arguments: readonly string[];
  readonly working_directory: string;
  readonly outcome: "matched" | "unmatched" | "exhausted";
}

/** A bounded loopback replay observation. */
export interface ProtocolEvent {
  readonly sequence: number;
  readonly at_ms: number;
  readonly protocol: "http" | "websocket";
  readonly direction: "request" | "response" | "received" | "sent";
  readonly method: string | null;
  readonly path: string | null;
  readonly data: string;
  readonly outcome:
    | "matched"
    | "unmatched"
    | "script_exhausted"
    | "disconnected"
    | "invalid_state"
    | "guard_failed"
    | "transition_exhausted"
    | "invalid_capture"
    | "unexpected_reconnect"
    | "limit_exhausted";
  readonly transition_id?: string | null | undefined;
  readonly state_before?: string | null | undefined;
  readonly state_after?: string | null | undefined;
}

/** Secret-safe state transition linked to its triggering protocol event. */
export interface ReplayTransitionEvent {
  readonly sequence: number;
  readonly at_ms: number;
  readonly protocol_event_sequence: number;
  readonly transition_id: string;
  readonly state_before: string;
  readonly state_after: string;
  readonly sensitive_aliases: readonly string[];
}

/**
 * Process Capture v4 observation set.
 *
 * `truncated` and `residual_unknowns` are semantic evidence: consumers must not
 * infer equivalence from matching bounded observations when either is present.
 */
export interface ProcessCapture {
  readonly schema_version: 4;
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
    readonly shim_plan: readonly unknown[];
    readonly replay_plan: Readonly<Record<string, unknown>>;
    readonly full_scenario_sha256: string;
    readonly comparison_contract_sha256: string;
    readonly executable_sha256: string;
    readonly normalization_sha256: string;
    readonly shim_plan_sha256: string;
    readonly replay_plan_sha256: string;
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
  readonly settlement: {
    readonly state: "quiesced" | "alive_at_deadline" | "unverifiable";
    readonly elapsed_ms: number;
    readonly cleanup_outcome: "not_required" | "cleaned" | "failed";
  };
  readonly process_samples: readonly ProcessSample[];
  readonly process_events: readonly ProcessLifecycleEvent[];
  readonly filesystem_checkpoints: readonly FilesystemCheckpoint[];
  readonly shim_events: readonly ShimEvent[];
  readonly protocol_events: readonly ProtocolEvent[];
  readonly replay_transitions?: readonly ReplayTransitionEvent[] | undefined;
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
      | "protocol"
      | "replay_transition"
      | "shim"
      | "cleanup"
      | "network";
    readonly reason: string;
  }[];
  readonly cleanup: {
    readonly owned_process_group: "verified";
    readonly temporary_root: "removed";
  };
}

const fileStateSchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory", "symlink", "other"]),
  mode: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  symlink_target: z.string().nullable(),
});
const fileEffectSchema = z.object({
  path: z.string(),
  status: z.enum(["created", "modified", "deleted", "unchanged"]),
  before: fileStateSchema.nullable(),
  after: fileStateSchema.nullable(),
});

/** Exact serialized shape of a bounded process capture. */
export const processCaptureSchema: z.ZodType<ProcessCapture> = z.object({
  schema_version: z.literal(4, {
    error: LEGACY_PROCESS_CAPTURE_MESSAGE,
  }),
  manifest: z.object({
    rea_version: z.string().min(1),
    provider_version: z.string().min(1),
    platform: z.string().min(1),
    architecture: z.string().min(1),
    pty_backend: z.literal("node-pty"),
    started_at: z.iso.datetime(),
    completed_at: z.iso.datetime(),
    scenario: z.record(z.string(), jsonValueSchema),
    comparison_contract: z.record(z.string(), jsonValueSchema),
    shim_plan: z.array(jsonValueSchema),
    replay_plan: z.record(z.string(), jsonValueSchema),
    full_scenario_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    comparison_contract_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    executable_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    normalization_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    shim_plan_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    replay_plan_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
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
  settlement: z.object({
    state: z.enum(["quiesced", "alive_at_deadline", "unverifiable"]),
    elapsed_ms: z.number().int().nonnegative(),
    cleanup_outcome: z.enum(["not_required", "cleaned", "failed"]),
  }),
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
  process_events: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      at_ms: z.number().int().nonnegative(),
      type: z.enum(["spawned", "reparented", "exited", "signal_dispatched"]),
      pid: z.number().int().positive(),
      parent_pid: z.number().int().nonnegative().nullable(),
      previous_parent_pid: z.number().int().nonnegative().nullable(),
      signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]).nullable(),
    }),
  ),
  filesystem_checkpoints: z.array(
    z.object({
      name: z.string(),
      at_ms: z.number().int().nonnegative(),
      files: z.array(fileStateSchema),
      effects: z.array(fileEffectSchema),
      truncated: z.boolean(),
    }),
  ),
  shim_events: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      at_ms: z.number().int().nonnegative(),
      command: z.string(),
      route_index: z.number().int().nonnegative().nullable(),
      arguments: z.array(z.string()),
      working_directory: z.string(),
      outcome: z.enum(["matched", "unmatched", "exhausted"]),
    }),
  ),
  protocol_events: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      at_ms: z.number().int().nonnegative(),
      protocol: z.enum(["http", "websocket"]),
      direction: z.enum(["request", "response", "received", "sent"]),
      method: z.string().nullable(),
      path: z.string().nullable(),
      data: z.string(),
      outcome: z.enum([
        "matched",
        "unmatched",
        "script_exhausted",
        "disconnected",
        "invalid_state",
        "guard_failed",
        "transition_exhausted",
        "invalid_capture",
        "unexpected_reconnect",
        "limit_exhausted",
      ]),
      transition_id: z.string().nullable().optional(),
      state_before: z.string().nullable().optional(),
      state_after: z.string().nullable().optional(),
    }),
  ),
  replay_transitions: z
    .array(
      z.object({
        sequence: z.number().int().nonnegative(),
        at_ms: z.number().int().nonnegative(),
        protocol_event_sequence: z.number().int().nonnegative(),
        transition_id: z.string(),
        state_before: z.string(),
        state_after: z.string(),
        sensitive_aliases: z.array(z.string()),
      }),
    )
    .max(100_000)
    .optional(),
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
        "protocol",
        "replay_transition",
        "shim",
        "cleanup",
        "network",
      ]),
      reason: z.string(),
    }),
  ),
  cleanup: z.object({
    owned_process_group: z.literal("verified"),
    temporary_root: z.literal("removed"),
  }),
});

export { validateProcessCapture } from "./processCaptureValidation.js";
import { validateProcessCapture } from "./processCaptureValidation.js";

/** Parse unknown input as v4 and reject invalid commitments or semantics. */
export const parseProcessCapture = (input: unknown): ProcessCapture => {
  if (
    typeof input === "object" &&
    input !== null &&
    "schema_version" in input &&
    input.schema_version === 3
  )
    throw new TypeError(LEGACY_PROCESS_CAPTURE_MESSAGE);
  const capture = processCaptureSchema.parse(input);
  const issues = validateProcessCapture(capture);
  if (issues.length > 0)
    throw new TypeError(
      `Invalid Process Capture v4: ${issues.map(({ path, message }) => `${path}: ${message}`).join("; ")}`,
    );
  return capture;
};

export {
  compareProcessCaptures,
  comparisonStatusSchema,
  deriveProcessComparisonStatus,
  PROCESS_COMPARISON_DIMENSIONS,
  processCaptureComparisonSchema,
} from "./processComparison.js";
