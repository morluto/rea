import { z } from "zod";

import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  END_CHECKPOINT,
  SEED_CHECKPOINT,
} from "../../domain/desktop/buildCapture.js";
import { parseEvidence } from "../../domain/evidence.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
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
