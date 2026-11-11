import { currentAnalysisOperationSnapshot } from "../domain/analysisOperationSnapshot.js";
import type { AnalysisSettingValues } from "../domain/analysisSettings.js";
import {
  DEBUGGER_CONTROL_REPLY_BYTES,
  DEFAULT_DEBUGGER_COMMAND_DEADLINE_MS,
  DEFAULT_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
  DEFAULT_DEBUGGER_MAX_PENDING_COMMANDS,
  DEFAULT_DEBUGGER_MAX_SESSIONS,
  MAXIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
  MAXIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
  MAXIMUM_DEBUGGER_MAX_PENDING_COMMANDS,
  MAXIMUM_DEBUGGER_MAX_SESSIONS,
  MINIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
  MINIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
  MINIMUM_DEBUGGER_MAX_PENDING_COMMANDS,
  MINIMUM_DEBUGGER_MAX_SESSIONS,
} from "../domain/analysisResourceLimits.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import { positiveDecimalIntegerSchema } from "./positiveDecimalInteger.js";

/**
 * Launch caps shared by GDB and Rizin. Each setting is declared here once.
 * Startup validation spreads {@link debuggerSessionLimitEnvironmentShape};
 * it does not restate the name, bounds, or schema.
 */
export const DEBUGGER_COMMAND_DEADLINE_SETTING =
  "REA_DEBUGGER_COMMAND_DEADLINE_MS";
export const DEBUGGER_MAX_SESSIONS_SETTING = "REA_DEBUGGER_MAX_SESSIONS";
export const DEBUGGER_MAX_PENDING_COMMANDS_SETTING =
  "REA_DEBUGGER_MAX_PENDING_COMMANDS";
export const DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING =
  "REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES";

/** Effective debugger admission and where its value came from. */
export interface DebuggerAdmissionLimit {
  readonly setting: string;
  readonly value: number;
  readonly source: "default" | "setting" | "runtime";
  readonly defaultValue: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly unit: "ms" | "bytes" | "sessions" | "commands";
}

const limit = (
  setting: string,
  value: number,
  minimum: number,
  maximum: number,
  unit: DebuggerAdmissionLimit["unit"],
): DebuggerAdmissionLimit => ({
  setting,
  value,
  source: "default",
  defaultValue: value,
  minimum,
  maximum,
  unit,
});

export const DEFAULT_DEBUGGER_COMMAND_DEADLINE: DebuggerAdmissionLimit = limit(
  DEBUGGER_COMMAND_DEADLINE_SETTING,
  DEFAULT_DEBUGGER_COMMAND_DEADLINE_MS,
  MINIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
  MAXIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
  "ms",
);
export const DEFAULT_DEBUGGER_MAX_SESSIONS_LIMIT: DebuggerAdmissionLimit =
  limit(
    DEBUGGER_MAX_SESSIONS_SETTING,
    DEFAULT_DEBUGGER_MAX_SESSIONS,
    MINIMUM_DEBUGGER_MAX_SESSIONS,
    MAXIMUM_DEBUGGER_MAX_SESSIONS,
    "sessions",
  );
export const DEFAULT_DEBUGGER_MAX_PENDING_COMMANDS_LIMIT: DebuggerAdmissionLimit =
  limit(
    DEBUGGER_MAX_PENDING_COMMANDS_SETTING,
    DEFAULT_DEBUGGER_MAX_PENDING_COMMANDS,
    MINIMUM_DEBUGGER_MAX_PENDING_COMMANDS,
    MAXIMUM_DEBUGGER_MAX_PENDING_COMMANDS,
    "commands",
  );
export const DEFAULT_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_LIMIT: DebuggerAdmissionLimit =
  limit(
    DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING,
    DEFAULT_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
    MINIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
    MAXIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
    "bytes",
  );

const constraintFor = (admission: DebuggerAdmissionLimit): string =>
  `${admission.setting} must be a positive decimal integer from ${String(admission.minimum)} to ${String(admission.maximum)} ${admission.unit}; the default is ${String(admission.defaultValue)} ${admission.unit}.${
    admission.unit === "ms"
      ? " Node schedules a delay above that maximum as 1 ms, so a larger value is refused."
      : ""
  }`;

const debuggerCommandDeadlineConstraint = constraintFor(
  DEFAULT_DEBUGGER_COMMAND_DEADLINE,
);
const debuggerMaxSessionsConstraint = constraintFor(
  DEFAULT_DEBUGGER_MAX_SESSIONS_LIMIT,
);
const debuggerMaxPendingCommandsConstraint = constraintFor(
  DEFAULT_DEBUGGER_MAX_PENDING_COMMANDS_LIMIT,
);
const debuggerMaxCommandOutputBytesConstraint = constraintFor(
  DEFAULT_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_LIMIT,
);

export const debuggerCommandDeadlineMsSchema = positiveDecimalIntegerSchema(
  MINIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
  MAXIMUM_DEBUGGER_COMMAND_DEADLINE_MS,
  debuggerCommandDeadlineConstraint,
);
export const debuggerMaxSessionsSchema = positiveDecimalIntegerSchema(
  MINIMUM_DEBUGGER_MAX_SESSIONS,
  MAXIMUM_DEBUGGER_MAX_SESSIONS,
  debuggerMaxSessionsConstraint,
);
export const debuggerMaxPendingCommandsSchema = positiveDecimalIntegerSchema(
  MINIMUM_DEBUGGER_MAX_PENDING_COMMANDS,
  MAXIMUM_DEBUGGER_MAX_PENDING_COMMANDS,
  debuggerMaxPendingCommandsConstraint,
);
export const debuggerMaxCommandOutputBytesSchema = positiveDecimalIntegerSchema(
  MINIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
  MAXIMUM_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES,
  debuggerMaxCommandOutputBytesConstraint,
);

/** Schemas startup validation spreads. The setting names are not restated. */
/** Restart-only debugger caps. Runtime deadline and output are parsed per call. */
export const debuggerSessionLimitEnvironmentShape = {
  [DEBUGGER_MAX_SESSIONS_SETTING]: debuggerMaxSessionsSchema.optional(),
  [DEBUGGER_MAX_PENDING_COMMANDS_SETTING]:
    debuggerMaxPendingCommandsSchema.optional(),
};

export interface DebuggerSessionLimits {
  readonly commandDeadline: DebuggerAdmissionLimit;
  readonly maxSessions: DebuggerAdmissionLimit;
  readonly maxPendingCommands: DebuggerAdmissionLimit;
  readonly maxCommandOutputBytes: DebuggerAdmissionLimit;
}

const RUNTIME_DEBUGGER_OVERRIDES = {
  [DEBUGGER_COMMAND_DEADLINE_SETTING]: "debugger.command_deadline_ms",
  [DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING]:
    "debugger.max_command_output_bytes",
} as const satisfies Partial<Record<string, keyof AnalysisSettingValues>>;

const parseOne = (
  admission: DebuggerAdmissionLimit,
  schema: ReturnType<typeof positiveDecimalIntegerSchema>,
  constraint: string,
  value: string | undefined,
): Result<DebuggerAdmissionLimit, ConfigurationError> => {
  if (value === undefined) return ok(admission);
  const parsed = schema.safeParse(value);
  if (parsed.success)
    return ok({ ...admission, value: parsed.data, source: "setting" });
  const override =
    RUNTIME_DEBUGGER_OVERRIDES[
      admission.setting as keyof typeof RUNTIME_DEBUGGER_OVERRIDES
    ];
  if (
    override !== undefined &&
    currentAnalysisOperationSnapshot()?.overrides[override] !== undefined
  )
    return ok(admission);
  return err(
    new ConfigurationError(constraint, {
      settings: [{ setting: admission.setting, constraint }],
    }),
  );
};

/** Parse the selected runtime cap without coupling it to another setting. */
export const parseDebuggerCommandDeadline = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  parseOne(
    DEFAULT_DEBUGGER_COMMAND_DEADLINE,
    debuggerCommandDeadlineMsSchema,
    debuggerCommandDeadlineConstraint,
    environment[DEBUGGER_COMMAND_DEADLINE_SETTING],
  );

export const parseDebuggerCommandOutput = (
  environment: Readonly<Record<string, string | undefined>>,
) =>
  parseOne(
    DEFAULT_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_LIMIT,
    debuggerMaxCommandOutputBytesSchema,
    debuggerMaxCommandOutputBytesConstraint,
    environment[DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING],
  );

/** Resolve every shared debugger cap from one environment. Invalid values are refused. */
export const parseDebuggerSessionLimits = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<DebuggerSessionLimits, ConfigurationError> => {
  const commandDeadline = parseDebuggerCommandDeadline(environment);
  const maxSessions = parseOne(
    DEFAULT_DEBUGGER_MAX_SESSIONS_LIMIT,
    debuggerMaxSessionsSchema,
    debuggerMaxSessionsConstraint,
    environment[DEBUGGER_MAX_SESSIONS_SETTING],
  );
  const maxPendingCommands = parseOne(
    DEFAULT_DEBUGGER_MAX_PENDING_COMMANDS_LIMIT,
    debuggerMaxPendingCommandsSchema,
    debuggerMaxPendingCommandsConstraint,
    environment[DEBUGGER_MAX_PENDING_COMMANDS_SETTING],
  );
  const maxCommandOutputBytes = parseDebuggerCommandOutput(environment);
  const settings = [
    commandDeadline,
    maxSessions,
    maxPendingCommands,
    maxCommandOutputBytes,
  ].flatMap((result) => (result.ok ? [] : result.error.settings));
  if (
    settings.length > 0 ||
    !commandDeadline.ok ||
    !maxSessions.ok ||
    !maxPendingCommands.ok ||
    !maxCommandOutputBytes.ok
  )
    return err(
      new ConfigurationError("Invalid REA environment configuration", {
        settings,
      }),
    );
  return ok({
    commandDeadline: commandDeadline.value,
    maxSessions: maxSessions.value,
    maxPendingCommands: maxPendingCommands.value,
    maxCommandOutputBytes: maxCommandOutputBytes.value,
  });
};

const RUNTIME_DEBUGGER_SETTINGS = new Set<string>([
  DEBUGGER_COMMAND_DEADLINE_SETTING,
  DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING,
]);

/**
 * Session and pending caps still fail construction. An invalid runtime deadline
 * or output cap does not: the next command reads the snapshot or the launch seed.
 */
export const debuggerConstructionLimits = (
  environment: Readonly<Record<string, string | undefined>>,
): DebuggerSessionLimits => {
  const parsed = parseDebuggerSessionLimits(environment);
  if (parsed.ok) return parsed.value;
  const blockers = parsed.error.settings.filter(
    (setting) => !RUNTIME_DEBUGGER_SETTINGS.has(setting.setting),
  );
  if (blockers.length > 0) throw parsed.error;
  const startup = { ...environment };
  delete startup[DEBUGGER_COMMAND_DEADLINE_SETTING];
  delete startup[DEBUGGER_MAX_COMMAND_OUTPUT_BYTES_SETTING];
  const again = parseDebuggerSessionLimits(startup);
  if (!again.ok) throw again.error;
  return again.value;
};

/** Refuse an invalid launch cap instead of falling back to the default. */
export const resolveDebuggerSessionLimits = (
  environment: Readonly<Record<string, string | undefined>>,
): DebuggerSessionLimits => {
  const parsed = parseDebuggerSessionLimits(environment);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

/**
 * Fixed budget for Rizin cleanup readback and GDB startup or detach MI.
 * This is not `REA_DEBUGGER_MAX_COMMAND_OUTPUT_BYTES`. A caller cap below
 * this budget must not truncate those required replies, and recovery for
 * this budget is not an environment setting.
 */
export const debuggerControlReplyOutput: DebuggerAdmissionLimit = {
  setting: "debugger control-reply budget",
  value: DEBUGGER_CONTROL_REPLY_BYTES,
  source: "default",
  defaultValue: DEBUGGER_CONTROL_REPLY_BYTES,
  minimum: DEBUGGER_CONTROL_REPLY_BYTES,
  maximum: DEBUGGER_CONTROL_REPLY_BYTES,
  unit: "bytes",
};
