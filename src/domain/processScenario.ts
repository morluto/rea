import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { z } from "zod";

const positiveBudget = z.number().int().safe().positive();
const timedEventBase = { at_ms: z.number().int().safe().nonnegative() };
const reservedRunIdEnvironmentName = "REA_PROCESS_RUN_ID";
const environmentName = z
  .string()
  .min(1, "Environment names must not be empty")
  .regex(/^(?!REA_PROCESS_RUN_ID(?![\s\S]))[^=\0]+$/u, {
    error: (issue) =>
      issue.input === reservedRunIdEnvironmentName
        ? `${reservedRunIdEnvironmentName} is reserved by the process adapter`
        : "Environment names cannot contain '=' or NUL",
  });
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

/** Compute a canonical SHA-256 commitment independent of object key order. */
export const digestProcessCommitment = (value: unknown): string => {
  const serialized = canonicalize(value);
  if (serialized === undefined)
    throw new TypeError("Process capture commitment is not canonical JSON");
  return createHash("sha256").update(serialized).digest("hex");
};

const committedScenarioEvents = (
  events: ProcessScenario["events"],
  includeSensitiveInputLength: boolean,
): ProcessScenario["events"] =>
  events.map((event) =>
    event.type === "input" && event.sensitive
      ? {
          ...event,
          data: includeSensitiveInputLength
            ? `<redacted-input:${String(Buffer.byteLength(event.data))}-bytes>`
            : "<redacted-input>",
        }
      : event,
  );

/** Build the caller-selected scenario projection committed by process-capture Evidence. */
export const processScenarioCommitment = (
  scenario: ProcessScenario,
  executableSha256?: string,
): Readonly<Record<string, unknown>> => ({
  ...scenario,
  events: committedScenarioEvents(scenario.events, true),
  executable_sha256: executableSha256 ?? null,
});

/** Project observation settings shared by capture and reconstruction. */
export const processComparisonContract = (
  scenario: ProcessScenario,
): Readonly<Record<string, unknown>> => ({
  working_directory: scenario.working_directory,
  environment: scenario.environment,
  ambient_environment: "unknown",
  filesystem_observation_paths: scenario.filesystem_observation_paths,
  terminal: scenario.terminal,
  // Input bytes are intentionally absent from compatibility identity. Their
  // redacted observations remain unknown, so equal commitments never imply
  // that two secret values were the same.
  events: committedScenarioEvents(scenario.events, false),
  timeout_ms: scenario.timeout_ms,
  idle_timeout_ms: scenario.idle_timeout_ms,
  settle_ms: scenario.settle_ms,
  limits: scenario.limits,
  normalization: scenario.normalization,
});

/**
 * Boundary schema for one bounded process experiment.
 * Defaults are part of the evidence contract and must remain deterministic.
 */
export const processScenarioSchema = z
  .object({
    executable: z.string().min(1),
    arguments: z.array(z.string()).default([]),
    working_directory: z.string().default("."),
    environment: z.record(environmentName, z.string()).default({}),
    filesystem_observation_paths: z.array(z.string().min(1)).default([]),
    terminal: z
      .object({
        columns: z.number().int().min(1).max(65_535).default(80),
        rows: z.number().int().min(1).max(65_535).default(24),
        scrollback: z.number().int().min(0).default(1_000),
      })
      .default({ columns: 80, rows: 24, scrollback: 1_000 }),
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
        filesystem_depth: z.number().int().safe().nonnegative().default(16),
      })
      .strict()
      .default({
        output_bytes: 1_000_000,
        files: 10_000,
        file_bytes: 10_000_000,
        processes: 1_000,
        filesystem_depth: 16,
      }),
    normalization: z
      .object({
        paths: z.boolean().default(false),
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
        paths: false,
        pids: true,
        ports: true,
        time_bucket_ms: 10,
        patterns: [],
      }),
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
    for (const event of scenario.events) {
      if (event.at_ms > scenario.timeout_ms) {
        context.addIssue({
          code: "custom",
          message: "event occurs after the scenario timeout",
          path: ["events"],
        });
      }
    }
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
