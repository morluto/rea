import { resolve } from "node:path";
import { z } from "zod";

const positiveBudget = z.number().int().positive();
const timedEventBase = { at_ms: z.number().int().nonnegative() };
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const reservedEnvironment = new Set([
  "HOME",
  "TERM",
  "REA_PROCESS_RUN_ID",
  "REA_REPLAY_HTTP_URL",
  "REA_REPLAY_WEBSOCKET_URL",
  "REA_SHIM_LEDGER_URL",
]);
const normalizationSchema = z.object({
  paths: z.boolean(),
  pids: z.boolean(),
  ports: z.boolean(),
  time_bucket_ms: positiveBudget.max(60_000),
  patterns: z.array(
    z.object({
      pattern: z.string().max(500),
      replacement: z.string().max(100),
    }),
  ),
});
const checkpointNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u);
const commandNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const outputChunkSchema = z.object({
  at_ms: z.number().int().nonnegative().max(300_000),
  stream: z.enum(["stdout", "stderr"]),
  data: z.string().max(1_000_000),
});

/** Exact boundary schema for bounded dynamic process scenarios. */
export const processScenarioSchema = z
  .object({
    approved: z
      .literal(true)
      .describe(
        "Explicit per-call acknowledgement that this operation launches the target",
      ),
    unknown_registry_approved: z
      .literal(true)
      .optional()
      .describe("Explicit approval to record capture residuals durably"),
    executable: z.string().startsWith("/"),
    arguments: z.array(z.string()).max(256).default([]),
    working_directory: z.string().startsWith("/"),
    environment: z.record(environmentName, z.string()).default({}),
    inherit_environment: z.array(environmentName).max(64).default([]),
    secret_aliases: z.array(environmentName).max(64).default([]),
    network_access: z.literal("host").default("host"),
    filesystem_roots: z.array(z.string().startsWith("/")).max(16).default([]),
    terminal: z
      .object({
        columns: z.number().int().min(1).max(1_000).default(80),
        rows: z.number().int().min(1).max(1_000).default(24),
        scrollback: z.number().int().min(0).max(10_000).default(1_000),
      })
      .default({ columns: 80, rows: 24, scrollback: 1_000 }),
    checkpoints: z
      .array(
        z.object({
          name: checkpointNameSchema,
          trigger: z.discriminatedUnion("type", [
            z.object({
              type: z.literal("time"),
              at_ms: z.number().int().nonnegative().max(300_000),
            }),
            z.object({
              type: z.literal("terminal_literal"),
              value: z.string().min(1).max(10_000),
              occurrence: z.number().int().positive().max(1_000).default(1),
            }),
            z.object({ type: z.literal("root_exit") }),
            z.object({ type: z.literal("settled") }),
          ]),
        }),
      )
      .max(64)
      .default([]),
    command_shims: z
      .array(
        z.object({
          name: commandNameSchema,
          routes: z
            .array(
              z.object({
                arguments: z.array(z.string()).max(256),
                outputs: z.array(outputChunkSchema).max(1_000).default([]),
                termination: z.discriminatedUnion("type", [
                  z.object({
                    type: z.literal("exit"),
                    code: z.number().int().min(0).max(255),
                  }),
                  z.object({
                    type: z.literal("signal"),
                    signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]),
                  }),
                ]),
                max_calls: z.number().int().positive().max(100).default(1),
              }),
            )
            .min(1)
            .max(100),
        }),
      )
      .max(32)
      .default([]),
    events: z
      .array(
        z.discriminatedUnion("type", [
          z.object({
            ...timedEventBase,
            type: z.literal("input"),
            data: z.string(),
            sensitive: z.boolean().default(false),
          }),
          z.object({
            ...timedEventBase,
            type: z.literal("resize"),
            columns: z.number().int().min(1).max(1_000),
            rows: z.number().int().min(1).max(1_000),
          }),
          z.object({
            ...timedEventBase,
            type: z.literal("signal"),
            signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]),
          }),
        ]),
      )
      .max(1_000)
      .default([]),
    timeout_ms: positiveBudget.max(300_000).default(30_000),
    idle_timeout_ms: positiveBudget.max(300_000).default(30_000),
    settle_ms: z.number().int().nonnegative().max(10_000).default(100),
    limits: z
      .object({
        output_bytes: positiveBudget.max(10_000_000).default(1_000_000),
        frames: positiveBudget.max(100_000).default(10_000),
        files: positiveBudget.max(100_000).default(10_000),
        file_bytes: positiveBudget.max(100_000_000).default(10_000_000),
        processes: positiveBudget.max(10_000).default(1_000),
        protocol_events: positiveBudget.max(100_000).default(10_000),
        protocol_body_bytes: positiveBudget.max(10_000_000).default(1_000_000),
        connections: positiveBudget.max(1_000).default(100),
        filesystem_depth: z.number().int().min(1).max(64).default(16),
      })
      .default({
        output_bytes: 1_000_000,
        frames: 10_000,
        files: 10_000,
        file_bytes: 10_000_000,
        processes: 1_000,
        protocol_events: 10_000,
        protocol_body_bytes: 1_000_000,
        connections: 100,
        filesystem_depth: 16,
      }),
    normalization: z
      .object({
        paths: z.boolean().default(true),
        pids: z.boolean().default(true),
        ports: z.boolean().default(true),
        time_bucket_ms: positiveBudget.max(60_000).default(10),
        patterns: z
          .array(
            z.object({
              pattern: z.string().max(500),
              replacement: z.string().max(100),
            }),
          )
          .max(32)
          .default([]),
      })
      .default({
        paths: true,
        pids: true,
        ports: true,
        time_bucket_ms: 10,
        patterns: [],
      }),
    replay: z
      .object({
        http: z
          .array(
            z.object({
              method: z.string().max(16),
              path: z.string().startsWith("/"),
              status: z.number().int().min(100).max(599),
              body: z.string().max(1_000_000),
              request_headers: z.record(z.string(), z.string()).default({}),
              request_body: z.string().max(1_000_000).optional(),
              response_headers: z.record(z.string(), z.string()).default({}),
              delay_ms: z.number().int().nonnegative().max(30_000).default(0),
              disconnect: z.boolean().default(false),
              max_calls: z.number().int().min(1).max(100).default(1),
            }),
          )
          .max(100)
          .default([]),
        websocket_messages: z
          .array(z.string().max(1_000_000))
          .max(100)
          .default([]),
        websocket_connections: z
          .array(
            z.object({
              messages: z
                .array(
                  z.object({
                    data: z.string().max(1_000_000),
                    delay_ms: z
                      .number()
                      .int()
                      .nonnegative()
                      .max(30_000)
                      .default(0),
                  }),
                )
                .max(100),
              disconnect_after: z.boolean().default(false),
            }),
          )
          .max(100)
          .default([]),
      })
      .default({
        http: [],
        websocket_messages: [],
        websocket_connections: [],
      }),
  })
  .strict()
  .superRefine((scenario, context) => {
    for (let index = 1; index < scenario.events.length; index += 1) {
      if (scenario.events[index]!.at_ms < scenario.events[index - 1]!.at_ms) {
        context.addIssue({
          code: "custom",
          message: "events must be ordered by at_ms",
          path: ["events", index],
        });
      }
    }
    const secrets = new Set(scenario.secret_aliases);
    for (const alias of secrets) {
      if (!(alias in scenario.environment)) {
        context.addIssue({
          code: "custom",
          message: "secret alias has no environment value",
          path: ["secret_aliases"],
        });
      }
    }
    const explicit = new Set(Object.keys(scenario.environment));
    for (const name of [...explicit, ...scenario.inherit_environment]) {
      if (reservedEnvironment.has(name)) {
        context.addIssue({
          code: "custom",
          message: `${name} is reserved by the process adapter`,
          path: ["environment", name],
        });
      }
    }
    for (const name of scenario.inherit_environment) {
      if (explicit.has(name)) {
        context.addIssue({
          code: "custom",
          message: "an environment name cannot be explicit and inherited",
          path: ["inherit_environment"],
        });
      }
    }
    for (const event of scenario.events) {
      if (event.at_ms > scenario.timeout_ms) {
        context.addIssue({
          code: "custom",
          message: "event occurs after the scenario timeout",
          path: ["events"],
        });
      }
    }
    const checkpointNames = scenario.checkpoints.map(({ name }) => name);
    for (const [index, name] of checkpointNames.entries()) {
      if (name === "before" || name === "after_settlement")
        context.addIssue({
          code: "custom",
          message: "checkpoint name is reserved by the capture lifecycle",
          path: ["checkpoints", index, "name"],
        });
    }
    if (new Set(checkpointNames).size !== checkpointNames.length)
      context.addIssue({
        code: "custom",
        message: "checkpoint names must be unique",
        path: ["checkpoints"],
      });
    const shimNames = scenario.command_shims.map(({ name }) => name);
    if (new Set(shimNames).size !== shimNames.length)
      context.addIssue({
        code: "custom",
        message: "command shim names must be unique",
        path: ["command_shims"],
      });
  });

/** A parsed, bounded dynamic process observation scenario. */
export type ProcessScenario = z.infer<typeof processScenarioSchema>;

/** Parse untrusted process scenario input and apply safe default budgets. */
export const parseProcessScenario = (input: unknown): ProcessScenario =>
  processScenarioSchema.parse(input);

/** Operator-owned policy for process capture. */
export interface ProcessExecutionPolicy {
  readonly enabled: boolean;
  readonly executableRoots: readonly string[];
  readonly workingRoots: readonly string[];
  readonly allowedEnvironment: readonly string[];
  readonly allowExternalNetwork: boolean;
}

/** A safe, caller-visible process-policy decision. */
export type ProcessPolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

const isWithin = (candidate: string, root: string): boolean =>
  resolve(candidate) === resolve(root) ||
  resolve(candidate).startsWith(
    `${resolve(root)}${resolve(root).endsWith("/") ? "" : "/"}`,
  );

/** Evaluate scenario authority before any process or filesystem side effect occurs. */
export const authorizeProcessScenario = (
  scenario: ProcessScenario,
  policy: ProcessExecutionPolicy,
): ProcessPolicyDecision => {
  if (!policy.enabled)
    return { allowed: false, reason: "process capture is disabled" };
  if (scenario.network_access === "host" && !policy.allowExternalNetwork)
    return {
      allowed: false,
      reason: "host network access is not approved by operator policy",
    };
  if (
    !policy.executableRoots.some((root) => isWithin(scenario.executable, root))
  ) {
    return { allowed: false, reason: "executable is outside approved roots" };
  }
  if (
    !policy.workingRoots.some((root) =>
      isWithin(scenario.working_directory, root),
    )
  ) {
    return {
      allowed: false,
      reason: "working directory is outside approved roots",
    };
  }
  const requestedNames = [
    ...Object.keys(scenario.environment),
    ...scenario.inherit_environment,
  ];
  if (
    requestedNames.some((name) => !policy.allowedEnvironment.includes(name))
  ) {
    return {
      allowed: false,
      reason: "scenario requests an environment variable not allowed by policy",
    };
  }
  if (
    scenario.filesystem_roots.some(
      (path) => !policy.workingRoots.some((root) => isWithin(path, root)),
    )
  ) {
    return {
      allowed: false,
      reason: "filesystem root is outside approved roots",
    };
  }
  return { allowed: true };
};

/** One bounded terminal observation. */
export interface TerminalFrame {
  readonly sequence: number;
  readonly at_ms: number;
  readonly data: string;
}

/** One rendered terminal state after xterm has parsed a PTY chunk or resize. */
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

/** One attempted scripted interaction with the PTY. */
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

/** A named filesystem observation captured during a process lifecycle. */
export interface FilesystemCheckpoint {
  readonly name: string;
  readonly at_ms: number;
  readonly files: readonly FileState[];
  readonly effects: readonly FileEffect[];
  readonly truncated: boolean;
}

/** One invocation observed by the declarative command-shim replay adapter. */
export interface ShimEvent {
  readonly sequence: number;
  readonly at_ms: number;
  readonly command: string;
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
    | "disconnected";
}

/** A bounded process observation with explicit incompleteness metadata. */
export interface ProcessCapture {
  readonly schema_version: 3;
  readonly normalization: z.infer<typeof normalizationSchema>;
  readonly frames: readonly TerminalFrame[];
  readonly rendered_frames: readonly RenderedTerminalFrame[];
  readonly interaction_events: readonly InteractionEvent[];
  readonly exit: {
    readonly code: number | null;
    readonly signal: number | null;
    readonly reason: "exited" | "timeout" | "idle_timeout";
  };
  readonly process_samples: readonly ProcessSample[];
  readonly filesystem_checkpoints: readonly FilesystemCheckpoint[];
  readonly shim_events: readonly ShimEvent[];
  readonly protocol_events: readonly ProtocolEvent[];
  readonly files_before: readonly FileState[];
  readonly files_after: readonly FileState[];
  readonly filesystem_effects: readonly FileEffect[];
  readonly truncated: boolean;
  readonly limitations: readonly string[];
  readonly residual_unknowns: readonly {
    readonly scope:
      | "terminal"
      | "exit"
      | "process"
      | "filesystem"
      | "protocol"
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
  schema_version: z.literal(3),
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
      ]),
    }),
  ),
  files_before: z.array(fileStateSchema),
  files_after: z.array(fileStateSchema),
  filesystem_effects: z.array(fileEffectSchema),
  truncated: z.boolean(),
  limitations: z.array(z.string()),
  residual_unknowns: z.array(
    z.object({
      scope: z.enum([
        "terminal",
        "exit",
        "process",
        "filesystem",
        "protocol",
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

export {
  compareProcessCaptures,
  comparisonStatusSchema,
  processCaptureComparisonSchema,
} from "./processComparison.js";
