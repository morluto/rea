import { createHash } from "node:crypto";
import { isPathWithinRoot } from "./localPath.js";
import canonicalize from "canonicalize";
import { z } from "zod";
import {
  processReactiveScenarioSchema,
  type ProcessReactiveScenario,
} from "./processReactiveScenario.js";
import { replayMachineSchema } from "./replayMachine.js";

const positiveBudget = z.number().int().safe().positive();
const timedEventBase = { at_ms: z.number().int().safe().nonnegative() };
const environmentName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const reservedEnvironment = new Set([
  "HOME",
  "TERM",
  "REA_PROCESS_RUN_ID",
  "REA_REPLAY_HTTP_URL",
  "REA_REPLAY_WEBSOCKET_URL",
  "REA_SHIM_LEDGER_URL",
]);
export const normalizationSchema = z.object({
  paths: z.boolean(),
  pids: z.boolean(),
  ports: z.boolean(),
  time_bucket_ms: positiveBudget,
  patterns: z.array(
    z.object({
      pattern: z.string(),
      replacement: z.string(),
    }),
  ),
});
const checkpointNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
const commandNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);
const outputChunkSchema = z.object({
  at_ms: z.number().int().safe().nonnegative(),
  stream: z.enum(["stdout", "stderr"]),
  data: z.string(),
});

/** Compute a canonical SHA-256 commitment independent of object key order. */
export const digestProcessCommitment = (value: unknown): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Process capture commitment is not canonical JSON");
  return createHash("sha256").update(serialized).digest("hex");
};

const reactiveScenarioCommitment = (
  scenario: ProcessReactiveScenario | null,
): Readonly<Record<string, unknown>> | null =>
  scenario === null
    ? null
    : {
        ...scenario,
        states: scenario.states.map((state) => ({
          ...state,
          on: state.on.map((transition) => ({
            ...transition,
            actions: transition.actions.map((action) =>
              action.type === "send_input" && action.sensitive
                ? {
                    ...action,
                    data: `<redacted-input:${String(Buffer.byteLength(action.data))}-bytes>`,
                  }
                : action,
            ),
          })),
        })),
      };

/** Build the secret-safe scenario projection committed by process-capture Evidence. */
export const processScenarioCommitment = (
  scenario: ProcessScenario,
  executableSha256?: string,
): Readonly<Record<string, unknown>> => ({
  ...scenario,
  environment: Object.fromEntries(
    Object.entries(scenario.environment).map(([name, value]) => [
      name,
      scenario.secret_aliases.includes(name) ? "<redacted-secret>" : value,
    ]),
  ),
  reactive: reactiveScenarioCommitment(scenario.reactive),
  executable_sha256: executableSha256 ?? null,
});

/** Project observation settings shared by authority and reconstruction. */
export const processComparisonContract = (
  scenario: ProcessScenario,
): Readonly<Record<string, unknown>> => ({
  working_directory: scenario.working_directory,
  inherit_environment: scenario.inherit_environment,
  secret_aliases: scenario.secret_aliases,
  network_access: scenario.network_access,
  filesystem_roots: scenario.filesystem_roots,
  terminal: scenario.terminal,
  checkpoints: scenario.checkpoints,
  events: scenario.events,
  timeout_ms: scenario.timeout_ms,
  idle_timeout_ms: scenario.idle_timeout_ms,
  settle_ms: scenario.settle_ms,
  limits: scenario.limits,
  normalization: scenario.normalization,
  command_shims: scenario.command_shims,
  replay: scenario.replay,
  reactive: reactiveScenarioCommitment(scenario.reactive),
});

/**
 * True when `value` is an absolute path for *any* supported host.
 *
 * `node:path`'s `isAbsolute` answers for the machine running it: on Linux
 * `C:\tools` is not absolute. A boundary schema must not vary with the host
 * that evaluates it — a scenario captured on Windows has to stay valid when it
 * is replayed, compared, or validated by a test on Linux. So this accepts the
 * POSIX form, a Windows drive path, and a UNC share, on every host.
 */
export const isAbsoluteScenarioPath = (value: string): boolean =>
  value.startsWith("/") ||
  /^[A-Za-z]:[\\/]/u.test(value) ||
  value.startsWith("\\\\");

/**
 * An absolute path for the host that will run the scenario. The message names
 * the constraint so a rejected path is actionable, instead of leaving the
 * caller to infer it from a generic "invalid request".
 */
const absoluteScenarioPath = z.string().refine(isAbsoluteScenarioPath, {
  message:
    "Path must be absolute: a POSIX path such as /usr/bin/node, a Windows path such as C:\\tools\\node.exe, or a UNC path such as \\\\server\\share",
});

/**
 * Boundary schema for one bounded process experiment.
 * Defaults are part of the evidence contract and must remain deterministic.
 */
export const processScenarioSchema = z
  .object({
    executable: absoluteScenarioPath,
    arguments: z.array(z.string()).default([]),
    working_directory: absoluteScenarioPath,
    environment: z.record(environmentName, z.string()).default({}),
    inherit_environment: z.array(environmentName).default([]),
    secret_aliases: z.array(environmentName).default([]),
    network_access: z.literal("host").default("host"),
    filesystem_roots: z.array(absoluteScenarioPath).default([]),
    terminal: z
      .object({
        columns: z.number().int().min(1).max(65_535).default(80),
        rows: z.number().int().min(1).max(65_535).default(24),
        scrollback: z.number().int().min(0).default(1_000),
      })
      .default({ columns: 80, rows: 24, scrollback: 1_000 }),
    checkpoints: z
      .array(
        z.object({
          name: checkpointNameSchema,
          trigger: z.discriminatedUnion("type", [
            z.object({
              type: z.literal("time"),
              at_ms: z.number().int().safe().nonnegative(),
            }),
            z.object({
              type: z.literal("terminal_literal"),
              value: z.string().min(1),
              occurrence: positiveBudget.default(1),
            }),
            z.object({ type: z.literal("root_exit") }),
            z.object({ type: z.literal("settled") }),
          ]),
        }),
      )
      .default([]),
    command_shims: z
      .array(
        z.object({
          name: commandNameSchema,
          routes: z
            .array(
              z.object({
                arguments: z.array(z.string()),
                outputs: z.array(outputChunkSchema).default([]),
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
                max_calls: positiveBudget.default(1),
              }),
            )
            .min(1),
        }),
      )
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
            columns: z.number().int().min(1).max(65_535),
            rows: z.number().int().min(1).max(65_535),
          }),
          z.object({
            ...timedEventBase,
            type: z.literal("signal"),
            signal: z.enum(["SIGINT", "SIGTERM", "SIGKILL"]),
          }),
        ]),
      )
      .default([]),
    timeout_ms: positiveBudget.default(30_000),
    idle_timeout_ms: positiveBudget.default(30_000),
    settle_ms: z.number().int().safe().nonnegative().default(100),
    limits: z
      .object({
        output_bytes: positiveBudget.default(1_000_000),
        files: positiveBudget.default(10_000),
        file_bytes: positiveBudget.default(10_000_000),
        processes: positiveBudget.default(1_000),
        protocol_events: positiveBudget.default(10_000),
        protocol_body_bytes: positiveBudget.default(1_000_000),
        connections: positiveBudget.default(100),
        filesystem_depth: z.number().int().safe().nonnegative().default(16),
      })
      .strict()
      .default({
        output_bytes: 1_000_000,
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
        time_bucket_ms: positiveBudget.default(10),
        patterns: z
          .array(
            z.object({
              pattern: z.string(),
              replacement: z.string(),
            }),
          )
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
        machine: replayMachineSchema.nullable().default(null),
        http: z
          .array(
            z.object({
              method: z.string(),
              path: z.string().startsWith("/"),
              status: z.number().int().min(100).max(599),
              body: z.string(),
              request_headers: z.record(z.string(), z.string()).default({}),
              request_body: z.string().optional(),
              response_headers: z.record(z.string(), z.string()).default({}),
              delay_ms: z.number().int().safe().nonnegative().default(0),
              disconnect: z.boolean().default(false),
              max_calls: positiveBudget.default(1),
            }),
          )
          .default([]),
        websocket_messages: z.array(z.string()).default([]),
        websocket_connections: z
          .array(
            z.object({
              messages: z.array(
                z.object({
                  data: z.string(),
                  delay_ms: z.number().int().safe().nonnegative().default(0),
                }),
              ),
              disconnect_after: z.boolean().default(false),
            }),
          )
          .default([]),
      })
      .default({
        machine: null,
        http: [],
        websocket_messages: [],
        websocket_connections: [],
      }),
    reactive: processReactiveScenarioSchema.nullable().default(null),
  })
  .strict()
  .superRefine((scenario, context) => {
    for (let index = 1; index < scenario.events.length; index += 1) {
      const event = scenario.events[index];
      const previous = scenario.events[index - 1];
      if (eventsOutOfOrder(event, previous)) {
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
    if (
      scenario.replay.machine !== null &&
      (scenario.replay.http.length > 0 ||
        scenario.replay.websocket_messages.length > 0 ||
        scenario.replay.websocket_connections.length > 0)
    )
      context.addIssue({
        code: "custom",
        message:
          "a replay machine cannot be combined with static HTTP or WebSocket scripts",
        path: ["replay"],
      });
  });

const eventsOutOfOrder = (
  event: { readonly at_ms: number } | undefined,
  previous: { readonly at_ms: number } | undefined,
): boolean =>
  event !== undefined && previous !== undefined && event.at_ms < previous.at_ms;

/** Parsed instructions and resource bounds for one process experiment. */
export type ProcessScenario = z.infer<typeof processScenarioSchema>;

/** Parse untrusted process scenario input and apply safe default budgets. */
export const parseProcessScenario = (input: unknown): ProcessScenario =>
  processScenarioSchema.parse(input);

/** Complete operator-owned ceiling for enabled process capture. */
export interface EnabledProcessExecutionPolicy {
  readonly status: "enabled";
  readonly executableRoots: readonly [string, ...string[]];
  readonly workingRoots: readonly [string, ...string[]];
  readonly allowedEnvironment: readonly string[];
  readonly networkAccess: "none" | "external";
}

/** Parsed operator-owned process-capture policy. */
export type ProcessExecutionPolicy =
  | { readonly status: "disabled" }
  | EnabledProcessExecutionPolicy;

/** Explicit authorization result; denial reasons are safe to show callers. */
export type ProcessPolicyDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | "process capture is disabled"
        | "host network access is not approved by operator policy"
        | "executable is outside approved roots"
        | "working directory is outside approved roots"
        | "scenario requests an environment variable not allowed by policy"
        | "filesystem root is outside approved roots";
    };

/** Evaluate scenario authority before any process or filesystem side effect occurs. */
export const authorizeProcessScenario = (
  scenario: ProcessScenario,
  policy: ProcessExecutionPolicy,
): ProcessPolicyDecision => {
  if (policy.status === "disabled")
    return { allowed: false, reason: "process capture is disabled" };
  if (scenario.network_access === "host" && policy.networkAccess === "none")
    return {
      allowed: false,
      reason: "host network access is not approved by operator policy",
    };
  if (
    !policy.executableRoots.some((root) =>
      isPathWithinRoot(root, scenario.executable),
    )
  ) {
    return { allowed: false, reason: "executable is outside approved roots" };
  }
  if (
    !policy.workingRoots.some((root) =>
      isPathWithinRoot(root, scenario.working_directory),
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
      (path) =>
        !policy.workingRoots.some((root) => isPathWithinRoot(root, path)),
    )
  ) {
    return {
      allowed: false,
      reason: "filesystem root is outside approved roots",
    };
  }
  return { allowed: true };
};
