import { z } from "zod";

import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  END_CHECKPOINT,
  SEED_CHECKPOINT,
} from "../../domain/desktop/buildCapture.js";
import { parseEvidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import {
  runBuildController,
  type ControlledComputer,
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

/** What REA's build controller answers a command with. */
export const answerSchema = z.looseObject({
  error: z.string().optional(),
  absent: z.boolean().optional(),
  line: z.string().optional(),
  exited: z.int().optional(),
  timed_out: z.boolean().optional(),
  progress: z.string().optional(),
  output: z.string().optional(),
  exit_code: z.int().nullable().optional(),
  output_bytes: z.int().nonnegative().optional(),
  stdout_bytes: z.int().nonnegative().optional(),
  stderr: z.string().optional(),
  apt: z
    .looseObject({ lists: z.int().nonnegative(), error: z.string().optional() })
    .optional(),
});
export type Answer = z.infer<typeof answerSchema>;

const cliFailureSchema = z.looseObject({
  code: z.string(),
  message: z.string(),
  remediation: z.looseObject({ action: z.string() }).optional(),
});

/** What REA reads from a command it ran in the computer: its Evidence result, or the failure it reported. */
export type CommandOutput =
  | { readonly kind: "result"; readonly result: unknown }
  | {
      readonly kind: "failure";
      readonly failure: z.infer<typeof cliFailureSchema>;
    };

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

/** One controller command, its answer parsed. */
export const controller = async (
  computer: ControlledComputer,
  command: "start" | "mark" | "stop",
  argumentsJson: Readonly<Record<string, JsonValue>>,
  options: { readonly timeoutS: number; readonly signal: AbortSignal },
): Promise<Answer> =>
  answerSchema.parse(
    await runBuildController(computer, command, argumentsJson, options),
  );

/**
 * Run one `rea` command in the computer with its output in a file under the
 * work folder, after writing the files it reads; the output's size.
 */
export const runRea = async (
  computer: ControlledComputer,
  argv: readonly string[],
  options: {
    readonly stdout: string;
    readonly files?: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
  },
): Promise<number> => {
  const answer = answerSchema.parse(
    await runBuildController(
      computer,
      "run",
      {
        work: WORK,
        argv: [...argv],
        stdout: options.stdout,
        files: { ...options.files },
        timeout_s: 1800,
      },
      { timeoutS: 1800, signal: options.signal },
    ),
  );
  if (answer.exit_code === undefined || answer.stdout_bytes === undefined)
    throw new Error(
      answer.error ?? `rea ${argv[0] ?? ""} did not finish in the computer.`,
    );
  return answer.stdout_bytes;
};

/** The Evidence result, or the reported failure, a REA command wrote to a file of `bytes` in the computer. */
export const readOutput = async (
  computer: ControlledComputer,
  path: string,
  bytes: number,
  signal: AbortSignal,
): Promise<CommandOutput> => {
  const content = (await computer.homeFiles([path], bytes, signal)).get(path);
  if (content === undefined) throw new Error(`The computer has no ${path}.`);
  const value: unknown = JSON.parse(content.toString("utf8"));
  const failure = cliFailureSchema.safeParse(value);
  return failure.success
    ? { kind: "failure", failure: failure.data }
    : { kind: "result", result: parseEvidence(value).normalized_result };
};
