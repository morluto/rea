import { z } from "incur";
import type { Logger } from "pino";

import { logCliCommand } from "../cliLogging.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import { finishCliEvidenceCommand } from "./cliEvidenceCallerPath.js";
import { withCommandCancellation } from "./commandCancellation.js";
import {
  describeContractCommand,
  type CliContractProjection,
  type ContractCliDescription,
  type ContractField,
  type ProjectedContract,
} from "./contractCliDescription.js";
import { projectCliAnalysisResult } from "./projectCliAnalysisResult.js";
import type { CliInstance } from "./types.js";

/**
 * Incur adapter for contract commands. The command itself is described in
 * `contractCliDescription.ts`; this module only renders that description as
 * Incur args and options and runs the handler.
 */

/** What a contract command's handler receives besides the contract input. */
export interface ContractCommandContext {
  readonly signal: AbortSignal;
  /** The contract name, which is the canonical operation. */
  readonly operation: string;
  /** Each caller-path field as the caller spelled it, before resolution. */
  readonly callerInputs: Readonly<Record<string, string>>;
}

/** A closeable one-shot service that inspects one contract input. */
export interface EvidenceInspectionService {
  inspect(
    input: unknown,
    options: { readonly signal: AbortSignal },
  ): Promise<Result<Evidence, AnalysisError>>;
  close(): Promise<void>;
}

const primaryCallerPath = ({
  operation,
  callerInputs,
}: ContractCommandContext): string => {
  const callerPath = callerInputs.path;
  if (callerPath === undefined)
    throw new Error(`${operation} has no caller path field named path`);
  return callerPath;
};

/**
 * Inspect through a closeable service, finish its cleanup, and record the
 * caller's spelling of `path` in the Evidence.
 */
export const inspectWithService =
  (service: () => EvidenceInspectionService, providerId: string) =>
  (input: unknown, context: ContractCommandContext) => {
    const callerPath = primaryCallerPath(context);
    const owned = service();
    return finishCliEvidenceCommand(
      callerPath,
      () => owned.inspect(input, { signal: context.signal }),
      owned,
      providerId,
      context.operation,
      context.signal,
    ).then(projectCliAnalysisResult);
  };

const descriptions = new WeakMap<CliInstance, ContractCliDescription[]>();

/** Commands registered on this CLI through `registerContractCommand`. */
export const contractCommandDescriptions = (
  cli: CliInstance,
): readonly ContractCliDescription[] => descriptions.get(cli) ?? [];

const incurOptions = (description: ContractCliDescription): z.ZodType => {
  const object = z.object(
    Object.fromEntries(
      description.parameters
        .filter(({ positional }) => !positional)
        .map(({ key, schema }) => [key, schema]),
    ),
  );
  const constrained =
    description.optionConstraints === undefined
      ? object
      : object.meta(description.optionConstraints);
  const { checkOptions } = description;
  return checkOptions === undefined
    ? constrained
    : constrained.superRefine((parsed, context) => {
        for (const { path, issue } of checkOptions(parsed))
          context.addIssue({ ...issue, path: [...path] } as never);
      });
};

/**
 * Register one CLI command described from a tool contract. The handler
 * receives the contract input, with caller paths made absolute.
 */
export const registerContractCommand = <
  Contract extends ProjectedContract,
  Value,
>(
  cli: CliInstance,
  logger: Logger,
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>>,
  run: (
    input: z.input<Contract["inputSchema"]>,
    context: ContractCommandContext,
  ) => Promise<Value>,
): void => {
  const description = describeContractCommand(contract, projection);
  const positionals = description.parameters.filter(
    ({ positional }) => positional,
  );
  const alias = Object.fromEntries(
    description.parameters.flatMap(({ key, alias: short, positional }) =>
      short === undefined || positional ? [] : [[key, short]],
    ),
  );
  cli.command(description.command, {
    description: description.description,
    ...(positionals.length === 0
      ? {}
      : {
          args: z.object(
            Object.fromEntries(
              positionals.map(({ key, schema }) => [key, schema]),
            ),
          ),
        }),
    options: incurOptions(description),
    ...(Object.keys(alias).length === 0 ? {} : { alias }),
    run: ({
      args,
      options,
    }: {
      readonly args?: Readonly<Record<string, unknown>>;
      readonly options: Readonly<Record<string, unknown>>;
    }) => {
      const values = { ...options, ...args };
      return withCommandCancellation((signal) =>
        logCliCommand(logger, description.command, () =>
          run(
            description.toContractInput(values) as z.input<
              Contract["inputSchema"]
            >,
            {
              signal,
              operation: contract.name,
              callerInputs: description.callerInputs(values),
            },
          ),
        ),
      );
    },
  } as never);
  const registered = descriptions.get(cli) ?? [];
  registered.push(description);
  descriptions.set(cli, registered);
};
