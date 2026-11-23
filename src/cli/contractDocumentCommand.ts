import { z } from "zod";
import type { Logger } from "pino";

import { logCliCommand } from "../cliLogging.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { parseCliJsonInput, resolveCliJsonPaths } from "./cliJsonInput.js";
import { jsonInputArgument } from "./jsonInputArgument.js";
import {
  describeContractDocumentCommand,
  type CliDocumentProjection,
  type DocumentContract,
  type CliEvidenceDeliveryChoice,
  type CliOptionShape,
  type CliOptionValues,
  type ContractField,
} from "./contractCliDescription.js";
import {
  contractDescriptionOperations,
  registerCliCommand,
} from "./commandRegistry.js";
import type { CliInstance } from "./types.js";

/** What a JSON-document command's handler receives besides the document. */
export interface ContractDocumentContext<
  CliOptions extends Readonly<Record<string, unknown>> = Readonly<
    Record<string, unknown>
  >,
  Parsed = unknown,
> {
  readonly signal: AbortSignal;
  /** The contract name, which is the canonical operation. */
  readonly operation: string;
  /** The document as decoded, before its caller paths were resolved. */
  readonly spelled: unknown;
  /** A document is never parsed at admission; see `parseWholeInput`. */
  readonly parsed: undefined;
  /**
   * The contract's parse of the document, with caller paths resolved, as
   * the whole contract input, or its refusal (issues name the caller's
   * spelling). It parses on first call and reuses the result, so a handler
   * whose document is not the whole input never parses it here. Read it
   * through `admittedContractInput`.
   */
  readonly parseWholeInput: () => Result<Parsed, AnalysisInputError>;
  /**
   * The document's transport frame as `--schema` advertises it. A handler
   * that reads other inputs first, such as an Evidence bundle, admits the
   * document with it beforehand; Evidence carriers stay with their owner.
   */
  readonly frame: z.ZodType;
  /** The admitted delivery, for a projection with `evidenceDelivery`. */
  readonly delivery: CliEvidenceDeliveryChoice | undefined;
  /** The projection's CLI-only options, whose effect the handler owns. */
  readonly cliOptions: CliOptions;
  /**
   * The session target as the caller spelled it, for a projection with
   * `sessionTarget`; undefined otherwise.
   */
  readonly sessionTarget: string | undefined;
  /**
   * The session target's opening fields the caller selected, in the opening
   * contract's spelling; empty without `sessionTarget.open`.
   */
  readonly opening: Readonly<Record<string, unknown>>;
}

/**
 * A document field the projection omits or takes as an option is refused
 * with its reason rather than passed to an owner that would act on it.
 */
const refusedDocumentFieldError = (
  operation: string,
  refusals: Readonly<Record<string, string>>,
  document: object,
): AnalysisError | undefined => {
  const issues = Object.entries(refusals)
    .filter(([field]) => Object.hasOwn(document, field))
    .map(([field, message]) => ({
      code: "custom" as const,
      path: [field],
      message,
      input: (document as Readonly<Record<string, unknown>>)[field],
    }));
  return issues.length === 0
    ? undefined
    : analysisInputErrorFromIssues(operation, issues, document);
};

/**
 * Register one CLI command whose whole contract input is one JSON document.
 * The handler receives the decoded document with its caller paths made
 * absolute, and admits it with the contract's owner.
 */
export const registerContractDocumentCommand = <
  Contract extends DocumentContract,
  Value,
  CliOptions extends CliOptionShape = Record<never, z.ZodType>,
>(
  cli: CliInstance,
  logger: Logger,
  contract: Contract,
  projection: CliDocumentProjection<ContractField<Contract>, CliOptions>,
  run: (
    document: unknown,
    context: ContractDocumentContext<
      CliOptionValues<CliOptions>,
      z.output<Contract["inputSchema"]>
    >,
  ) => Promise<Value>,
): void => {
  const description = describeContractDocumentCommand(contract, projection);
  const options = Object.fromEntries(
    [
      ...(description.sessionTarget?.options ?? []),
      ...description.deliveryOptions,
      ...description.cliOnlyOptions,
    ].map(({ key, schema }) => [key, schema]),
  );
  registerCliCommand(
    cli,
    description.command,
    {
      description: description.description,
      args: z.object({
        ...(description.sessionTarget === undefined
          ? {}
          : {
              [description.sessionTarget.key]: description.sessionTarget.schema,
            }),
        [description.key]: jsonInputArgument(
          description.documentDescription,
          description.content,
        ),
      }),
      ...(Object.keys(options).length === 0
        ? {}
        : { options: z.object(options) }),
      run: ({
        args,
        options: values,
      }: {
        readonly args: Readonly<Record<string, string>>;
        readonly options: Readonly<Record<string, unknown>>;
      }) =>
        withCommandCancellation((signal) =>
          logCliCommand(logger, description.command, async () => {
            // Delivery options are checked before the document is read.
            const delivery = description.admitDelivery(values);
            if (!delivery.ok) return projectAnalysisError(delivery.error);
            const opening =
              description.sessionTarget === undefined
                ? ok({} as Readonly<Record<string, unknown>>)
                : description.sessionTarget.admitOpening(
                    description.contract.name,
                    { ...values, ...args },
                  );
            if (!opening.ok) return projectAnalysisError(opening.error);
            const decoded = await parseCliJsonInput(
              args[description.key]!,
              contract.name,
              signal,
            );
            if (!decoded.ok) return decoded.error;
            // A document that is not an object has no fields to refuse; the
            // contract refuses it.
            const refused =
              typeof decoded.value === "object" && decoded.value !== null
                ? refusedDocumentFieldError(
                    contract.name,
                    description.documentRefusals,
                    decoded.value,
                  )
                : undefined;
            if (refused !== undefined) return projectAnalysisError(refused);
            const document = resolveCliJsonPaths(
              decoded.value,
              description.callerPaths,
            );
            let admitted:
              | Result<z.output<Contract["inputSchema"]>, AnalysisInputError>
              | undefined;
            const parseWholeInput = () =>
              (admitted ??= (() => {
                const parsed = contract.inputSchema.safeParse(document);
                return parsed.success
                  ? ok(parsed.data as z.output<Contract["inputSchema"]>)
                  : err(
                      analysisInputErrorFromIssues(
                        contract.name,
                        parsed.error.issues,
                        decoded.value,
                      ),
                    );
              })());
            return run(document, {
              signal,
              operation: contract.name,
              spelled: decoded.value,
              parsed: undefined,
              parseWholeInput,
              frame: description.content,
              delivery: delivery.value,
              opening: opening.value,
              sessionTarget:
                description.sessionTarget === undefined
                  ? undefined
                  : args[description.sessionTarget.key],
              cliOptions: description.cliOptionValues(
                values,
              ) as CliOptionValues<CliOptions>,
            });
          }),
        ),
    } as never,
    {
      // A document's fields are set in the document, not by flags.
      operations: contractDescriptionOperations({
        contract: description.contract,
        sessionTarget: description.sessionTarget,
      }),
      source: { kind: "document", description },
    },
  );
};
