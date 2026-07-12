import { resolve } from "node:path";
import { z } from "zod";

const positiveBudget = z.number().int().positive();
const timedEventBase = { at_ms: z.number().int().nonnegative() };

/** Exact boundary schema for bounded dynamic process scenarios. */
export const processScenarioSchema = z
  .object({
    approved: z
      .literal(true)
      .describe(
        "Explicit per-call acknowledgement that this operation launches the target",
      ),
    executable: z.string().startsWith("/"),
    arguments: z.array(z.string()).max(256).default([]),
    working_directory: z.string().startsWith("/"),
    environment: z.record(z.string(), z.string()).default({}),
    inherit_environment: z.array(z.string()).max(64).default([]),
    secret_aliases: z.array(z.string()).max(64).default([]),
    filesystem_roots: z.array(z.string().startsWith("/")).max(16).default([]),
    events: z
      .array(
        z.discriminatedUnion("type", [
          z.object({
            ...timedEventBase,
            type: z.literal("input"),
            data: z.string(),
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
      })
      .default({
        output_bytes: 1_000_000,
        frames: 10_000,
        files: 10_000,
        file_bytes: 10_000_000,
        processes: 1_000,
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
            }),
          )
          .max(100)
          .default([]),
        websocket_messages: z
          .array(z.string().max(1_000_000))
          .max(100)
          .default([]),
      })
      .default({ http: [], websocket_messages: [] }),
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

/** One filesystem state used for before/after comparison. */
export interface FileState {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly mode: number;
  readonly size: number;
  readonly sha256: string | null;
  readonly symlink_target: string | null;
}

/** A sampled owned-process observation; sampling cannot prove syscall completeness. */
export interface ProcessSample {
  readonly at_ms: number;
  readonly pid: number;
  readonly parent_pid: number;
  readonly command: string;
}

/** A bounded loopback replay observation. */
export interface ProtocolEvent {
  readonly sequence: number;
  readonly protocol: "http" | "websocket";
  readonly direction: "request" | "response" | "received" | "sent";
  readonly method: string | null;
  readonly path: string | null;
  readonly data: string;
}

/** A bounded process observation with explicit incompleteness metadata. */
export interface ProcessCapture {
  readonly schema_version: 1;
  readonly frames: readonly TerminalFrame[];
  readonly exit: {
    readonly code: number | null;
    readonly signal: number | null;
  };
  readonly process_samples: readonly ProcessSample[];
  readonly protocol_events: readonly ProtocolEvent[];
  readonly files_before: readonly FileState[];
  readonly files_after: readonly FileState[];
  readonly truncated: boolean;
  readonly limitations: readonly string[];
}

/** Exact serialized shape of a bounded process capture. */
export const processCaptureSchema: z.ZodType<ProcessCapture> = z.object({
  schema_version: z.literal(1),
  frames: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      at_ms: z.number().int().nonnegative(),
      data: z.string(),
    }),
  ),
  exit: z.object({
    code: z.number().int().nullable(),
    signal: z.number().int().nullable(),
  }),
  process_samples: z.array(
    z.object({
      at_ms: z.number().int().nonnegative(),
      pid: z.number().int().positive(),
      parent_pid: z.number().int().nonnegative(),
      command: z.string(),
    }),
  ),
  protocol_events: z.array(
    z.object({
      sequence: z.number().int().nonnegative(),
      protocol: z.enum(["http", "websocket"]),
      direction: z.enum(["request", "response", "received", "sent"]),
      method: z.string().nullable(),
      path: z.string().nullable(),
      data: z.string(),
    }),
  ),
  files_before: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["file", "directory", "symlink", "other"]),
      mode: z.number().int().nonnegative(),
      size: z.number().int().nonnegative(),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .nullable(),
      symlink_target: z.string().nullable(),
    }),
  ),
  files_after: z.array(
    z.object({
      path: z.string(),
      type: z.enum(["file", "directory", "symlink", "other"]),
      mode: z.number().int().nonnegative(),
      size: z.number().int().nonnegative(),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .nullable(),
      symlink_target: z.string().nullable(),
    }),
  ),
  truncated: z.boolean(),
  limitations: z.array(z.string()),
});

/** Comparison classification that never equates incomplete evidence. */
type ComparisonStatus =
  | "unchanged"
  | "added"
  | "removed"
  | "changed"
  | "truncated"
  | "unknown";

/** Pure normalized comparison between two captures. */
export interface ProcessCaptureComparison {
  readonly status: ComparisonStatus;
  readonly terminal: ComparisonStatus;
  readonly exit: ComparisonStatus;
  readonly filesystem: ComparisonStatus;
  readonly protocol: ComparisonStatus;
  readonly process: ComparisonStatus;
  readonly limitations: readonly string[];
}

const stableFiles = (files: readonly FileState[]): string =>
  JSON.stringify(
    [...files].sort((left, right) => left.path.localeCompare(right.path)),
  );

/** Compare bounded captures without claiming equality for incomplete observations. */
export const compareProcessCaptures = (
  left: ProcessCapture,
  right: ProcessCapture,
): ProcessCaptureComparison => {
  if (left.truncated || right.truncated) {
    return {
      status: "truncated",
      terminal: "truncated",
      exit: "truncated",
      filesystem: "truncated",
      protocol: "truncated",
      process: "truncated",
      limitations: ["At least one capture is truncated."],
    };
  }
  const terminal =
    left.frames.map(({ data }) => data).join("") ===
    right.frames.map(({ data }) => data).join("")
      ? "unchanged"
      : "changed";
  const exit =
    JSON.stringify(left.exit) === JSON.stringify(right.exit)
      ? "unchanged"
      : "changed";
  const filesystem =
    stableFiles(left.files_after) === stableFiles(right.files_after)
      ? "unchanged"
      : "changed";
  const protocol =
    JSON.stringify(left.protocol_events) ===
    JSON.stringify(right.protocol_events)
      ? "unchanged"
      : "changed";
  const process =
    JSON.stringify(left.process_samples.map(({ command }) => command)) ===
    JSON.stringify(right.process_samples.map(({ command }) => command))
      ? "unchanged"
      : "changed";
  const status =
    terminal === "unchanged" &&
    exit === "unchanged" &&
    filesystem === "unchanged" &&
    protocol === "unchanged" &&
    process === "unchanged"
      ? "unchanged"
      : "changed";
  return {
    status,
    terminal,
    exit,
    filesystem,
    protocol,
    process,
    limitations: [...left.limitations, ...right.limitations],
  };
};
