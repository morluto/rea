import { z } from "zod";

import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  END_CHECKPOINT,
  SEED_CHECKPOINT,
} from "../../domain/desktop/buildCapture.js";
import { parseEvidence } from "../../domain/evidence.js";
import {
  jsonObjectSchema,
  jsonValueSchema,
  type JsonValue,
} from "../../domain/jsonValue.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import {
  guestFileAnswerCeiling,
  guestFileAnswerRefusal,
} from "../../desktop/AgentEnvComputer.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import {
  runRea as runControllerRea,
  type ControlledComputer,
} from "../../desktop/BuildComputerController.js";

export {
  controller,
  type Answer,
} from "../../desktop/BuildComputerController.js";

/** The work folder REA keeps under the computer user's home; every capture leaves it out. */
export const WORK = ".rea-build";
/** The checkpoint options the draft and the export read the seed and the end with. */
export const ENDS = [
  "--seed-checkpoint",
  SEED_CHECKPOINT,
  "--end-checkpoint",
  END_CHECKPOINT,
] as const;

const cliFailureSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  remediation: z.looseObject({ action: z.string() }).optional(),
  details: z.record(z.string(), jsonValueSchema).optional(),
});

/** A failure a REA command in the computer reported, and the whole projection it reported it as. */
export interface CommandFailure {
  readonly failure: z.infer<typeof cliFailureSchema>;
  readonly reported: Readonly<Record<string, JsonValue>>;
}

/** What REA reads from a command it ran in the computer: its Evidence result, or the failure it reported. */
export type CommandOutput =
  | { readonly kind: "result"; readonly result: unknown }
  | ({ readonly kind: "failure" } & CommandFailure);

export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

export const adapterError = (
  operation: string,
  userMessage: string,
  cause?: unknown,
): ProviderAdapterError =>
  new ProviderAdapterError(AGENTENV_PROVIDER, operation, {
    userMessage,
    ...(cause === undefined ? {} : { cause }),
  });

const cleanupTargetsSchema = z.object({
  cleanup: z.literal("incomplete"),
  resources: z.array(z.string()),
  cleanup_reason: z.string().optional(),
});

/**
 * A failure a REA command in the computer reported, as this step's error:
 * its message after `lead`, its remediation, the whole failure under
 * `details.diagnostics.command_failure`, and an incomplete cleanup's targets,
 * such as run tokens and paths, kept as this error's own, since its
 * remediation names them as listed.
 */
export const reportedFailure = (
  operation: string,
  { failure, reported }: CommandFailure,
  lead = "",
): ProviderAdapterError => {
  const cleanup = cleanupTargetsSchema.safeParse(failure.details);
  return new ProviderAdapterError(AGENTENV_PROVIDER, operation, {
    userMessage: `${lead}${failure.message}`,
    ...(failure.remediation === undefined
      ? {}
      : { remediationAction: failure.remediation.action }),
    diagnostics: { command_failure: reported },
    ...(cleanup.success
      ? {
          cleanup: {
            reason:
              cleanup.data.cleanup_reason ??
              "the command's cleanup is incomplete",
            resources: cleanup.data.resources,
          },
        }
      : {}),
  });
};

/** A valid request the build's current state cannot take, with what to do instead. */
export const refused = (
  operation: string,
  userMessage: string,
  remediationAction: string,
): AnalysisInputError =>
  new AnalysisInputError(operation, {
    userMessage,
    remediationAction,
    conformsToInputContract: true,
  });

/** Run one `rea` command in the computer; the controller owns the reply's fields. */
export const runRea = (
  computer: ControlledComputer,
  argv: readonly string[],
  options: {
    readonly stdout: string;
    readonly files?: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
): Promise<number> =>
  runControllerRea(computer, argv, { ...options, work: WORK });

/** `value` with `redact` applied to each of its strings and keys. */
const redactedJson = (
  value: JsonValue,
  redact: (text: string) => string,
): JsonValue => {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return value.map((item) => redactedJson(item, redact));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      redact(key),
      redactedJson(item, redact),
    ]),
  );
};

/**
 * The Evidence result, or the reported failure, a REA command wrote to a file
 * of `bytes` in the computer, with the control token replaced in every
 * string, as in a command's own output; the Evidence is checked first, since
 * its digest covers what the command wrote.
 */
export const readOutput = async (
  computer: ControlledComputer,
  path: string,
  bytes: number,
  signal: AbortSignal,
): Promise<CommandOutput> => {
  const refusal = guestFileAnswerRefusal(bytes, 1, guestFileAnswerCeiling());
  if (refusal !== undefined) throw refusal;
  const content = (await computer.homeFiles([path], bytes, signal)).get(path);
  if (content === undefined) throw new Error(`The computer has no ${path}.`);
  const value: unknown = JSON.parse(content.toString("utf8"));
  const redact = (text: string) => computer.redacted(text);
  if (cliFailureSchema.safeParse(value).success) {
    const reported = jsonObjectSchema.parse(
      redactedJson(jsonObjectSchema.parse(value), redact),
    );
    return {
      kind: "failure",
      failure: cliFailureSchema.parse(reported),
      reported,
    };
  }
  return {
    kind: "result",
    result: redactedJson(parseEvidence(value).normalized_result, redact),
  };
};
