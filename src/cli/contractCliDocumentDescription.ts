import { z } from "zod";

import type { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import { getEvidenceInputContract } from "../domain/evidenceInputContract.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  analysisEvidenceDeliveryOptions,
  cliEvidenceDeliveryInputError,
} from "./analysisEvidenceDeliveryOptions.js";
import { cliJsonCallerPathSchema } from "./cliJsonInput.js";
import { parseCliJsonOption } from "./cliJsonOption.js";
import type {
  CliEvidenceDeliveryChoice,
  CliOnlyOption,
  CliOptionShape,
  CliSessionTarget,
  CliViewDelivery,
  ContractCliSessionTarget,
  ContractField,
  DocumentContract,
  ProjectedContract,
} from "./contractCliDescriptionTypes.js";
import {
  admitsOmission,
  core,
  describeCliOnlyOption,
  describeSessionTarget,
  projectedCommand,
  selectCliOptionValues,
  viewOptionHelp,
} from "./contractCliSchemaProjection.js";

/**
 * The CLI spelling of a contract whose whole input is one JSON document:
 * inline JSON, a JSON file path, or `-` for standard input.
 */
export interface CliDocumentProjection<
  Field extends string,
  CliOptions extends CliOptionShape = CliOptionShape,
> {
  /** Omitted for the contract's own command; see `CliContractProjection`. */
  readonly command?: string;
  readonly description: string;
  /** Help for the document argument. */
  readonly document: string;
  /**
   * Property paths of caller paths inside the document. Each nonblank string
   * there that is not a URL is resolved against the working directory.
   */
  readonly callerPaths?: readonly (readonly string[])[];
  /**
   * Optional top-level fields this one-shot command does not admit, each with
   * the reason; `--schema` leaves them out of the document.
   */
  readonly omit?: { readonly [Key in Field]?: string };
  /** Options no contract field owns, keyed by their CLI key. */
  readonly cliOptions?: CliOptions;
  /**
   * The operation runs on the target an MCP session holds open. The CLI takes
   * it as the `path` positional before the document.
   */
  readonly sessionTarget?: CliSessionTarget;
  /**
   * The contract's optional `detail` field is taken as `--detail` beside the
   * document, with `--evidence_output`: the command delivers complete
   * Evidence or a summary saved beside a bundle. The document refuses
   * `detail`.
   */
  readonly evidenceDelivery?: true;
  /**
   * With `evidenceDelivery`, the contract's optional `view` field is taken as
   * `--view` JSON text beside the document and admitted by the contract
   * field's schema before the handler runs. The document refuses `view`.
   */
  readonly viewDelivery?: CliViewDelivery;
}

/** A complete, framework-neutral CLI command whose input is one JSON document. */
export interface ContractCliDocumentDescription {
  readonly command: string;
  readonly description: string;
  readonly contract: DocumentContract;
  /** The argument key, which no option shares. */
  readonly key: string;
  /** Help for the document argument. */
  readonly documentDescription: string;
  /**
   * What the document admits as `--schema` advertises it: the contract input
   * without omitted fields, with each Evidence carrier left to its owner.
   */
  readonly content: z.ZodType;
  /** Property paths of caller paths inside the document. */
  readonly callerPaths: readonly (readonly string[])[];
  /** Contract fields the command does not admit, with the reason. */
  readonly omitted: Readonly<Record<string, string>>;
  /** Contract fields taken as options beside the document, keyed by field. */
  readonly flagged: Readonly<Record<string, string>>;
  /**
   * The refusal of each top-level document field the command does not take
   * in the document: omitted fields and fields taken as options.
   */
  readonly documentRefusals: Readonly<Record<string, string>>;
  /** The session target positional, taken before the document, if any. */
  readonly sessionTarget: ContractCliSessionTarget | undefined;
  /** Options that select Evidence delivery, for `evidenceDelivery`. */
  readonly deliveryOptions: readonly CliOnlyOption[];
  /**
   * The delivery the parsed options select, admitted before the handler
   * runs; undefined without `evidenceDelivery`.
   */
  readonly admitDelivery: (
    values: Readonly<Record<string, unknown>>,
  ) => Result<CliEvidenceDeliveryChoice | undefined, AnalysisInputError>;
  readonly cliOnlyOptions: readonly CliOnlyOption[];
  /** The parsed values of the projection's CLI-only options. */
  readonly cliOptionValues: (
    values: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
}

/**
 * The document field at `path` as the CLI admits it: a caller path the
 * command resolves against the working directory, so a relative spelling is
 * admitted where the contract requires an absolute one. Unions and wrappers
 * keep their other branches; clones keep the source's registry metadata.
 */
const admitDocumentCallerPath = (
  schema: z.ZodType,
  path: readonly string[],
): z.ZodType => {
  const [head, ...tail] = path;
  if (head === undefined) {
    const admitted =
      core(schema) instanceof z.ZodArray
        ? z.array(cliJsonCallerPathSchema)
        : cliJsonCallerPathSchema;
    const field = admitsOmission(schema) ? admitted.optional() : admitted;
    return schema.description === undefined
      ? field
      : field.describe(schema.description);
  }
  if (
    schema instanceof z.ZodOptional ||
    schema instanceof z.ZodExactOptional ||
    schema instanceof z.ZodDefault ||
    schema instanceof z.ZodPrefault ||
    schema instanceof z.ZodNullable ||
    schema instanceof z.ZodReadonly
  )
    return z.clone(
      schema,
      {
        ...schema.def,
        innerType: admitDocumentCallerPath(schema.unwrap() as z.ZodType, path),
      },
      { parent: true },
    );
  if (schema instanceof z.ZodUnion)
    return z.clone(
      schema,
      {
        ...schema.def,
        options: schema.options.map((option) =>
          admitDocumentCallerPath(option as z.ZodType, path),
        ),
      },
      { parent: true },
    );
  if (schema instanceof z.ZodObject && Object.hasOwn(schema.shape, head))
    return z.clone(
      schema,
      {
        ...schema.def,
        shape: {
          ...schema.shape,
          [head]: admitDocumentCallerPath(
            schema.shape[head] as z.ZodType,
            tail,
          ),
        },
      },
      { parent: true },
    );
  return schema;
};

/** The CLI key of a JSON input document. */
const DOCUMENT_KEY = "inputJson";

/**
 * The delivery `--detail`, `--evidence_output` and `--view` select beside a
 * JSON document. The view is admitted by the contract's own `view` field; a
 * page is selected from a retained summary, so it needs summary delivery.
 */
const admitDocumentDelivery = (
  contract: Pick<ProjectedContract, "name" | "effects">,
  viewDelivery: (CliViewDelivery & { readonly schema: z.ZodType }) | undefined,
  values: Readonly<Record<string, unknown>>,
): Result<CliEvidenceDeliveryChoice, AnalysisInputError> => {
  const operation = contract.name;
  let view: AnalysisViewRequest | undefined;
  if (viewDelivery !== undefined) {
    const decoded = parseCliJsonOption(
      operation,
      "view",
      values.view as string | undefined,
      viewDelivery.invalidJson,
    );
    if (!decoded.ok) return decoded;
    if (decoded.value !== undefined) {
      const candidate = { view: decoded.value };
      const parsed = z
        .object({ view: viewDelivery.schema })
        .safeParse(candidate);
      if (!parsed.success)
        return err(
          analysisInputErrorFromIssues(
            operation,
            parsed.error.issues,
            candidate,
          ),
        );
      const selected = parsed.data.view as object;
      view = (
        viewDelivery.kind === undefined
          ? selected
          : { kind: viewDelivery.kind, ...selected }
      ) as AnalysisViewRequest;
    }
  }
  const detail =
    (values.detail as "complete" | "summary" | undefined) ??
    (view === undefined ? undefined : "summary");
  const delivery: CliEvidenceDeliveryChoice = {
    detail,
    evidenceOutput: values.evidence_output as string | undefined,
    rerunRecoversResult: contract.effects?.idempotent !== false,
    ...(view === undefined ? {} : { view }),
  };
  const refused = cliEvidenceDeliveryInputError({ ...delivery, operation });
  return refused === undefined ? ok(delivery) : err(refused);
};

/**
 * Describe a contract command that takes its whole input as one JSON
 * document. The handler admits the decoded document with the contract's
 * owner, which borrows Evidence carriers rather than parsing them here.
 */
export const describeContractDocumentCommand = <
  Contract extends DocumentContract,
  CliOptions extends CliOptionShape = CliOptionShape,
>(
  contract: Contract,
  projection: CliDocumentProjection<ContractField<Contract>, CliOptions>,
): ContractCliDocumentDescription => {
  const omitted: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(projection.omit ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const evidenceDelivery = projection.evidenceDelivery === true;
  const { viewDelivery } = projection;
  if (viewDelivery !== undefined && !evidenceDelivery)
    throw new Error(`${contract.name} view delivery requires evidenceDelivery`);
  // Delivery fields keep their contract names as CLI keys.
  const flagged: Readonly<Record<string, string>> = Object.fromEntries(
    (evidenceDelivery
      ? viewDelivery === undefined
        ? ["detail"]
        : ["detail", "view"]
      : []
    ).map((field) => [field, field]),
  );
  for (const field of Object.keys(flagged))
    if (Object.hasOwn(omitted, field))
      throw new Error(
        `${contract.name}.${field} is both omitted and an option`,
      );
  const removed = [...Object.keys(omitted), ...Object.keys(flagged)];
  let admitted: z.ZodType = contract.inputSchema;
  let viewSchema: z.ZodType = z.never();
  if (removed.length > 0) {
    const schema = contract.inputSchema;
    if (!(schema instanceof z.ZodObject))
      throw new Error(`${contract.name} omits fields from a union input`);
    const shape = schema.shape as Record<string, z.ZodType>;
    for (const field of removed)
      if (!Object.hasOwn(shape, field) || !admitsOmission(shape[field]!))
        throw new Error(`${contract.name}.${field} is not an optional field`);
    if (viewDelivery !== undefined) viewSchema = shape.view!;
    admitted = schema.omit(
      Object.fromEntries(removed.map((field) => [field, true])) as never,
    );
  }
  const callerPaths = projection.callerPaths ?? [];
  for (const path of callerPaths)
    admitted = admitDocumentCallerPath(admitted, path);
  const cliOptions: CliOptionShape = projection.cliOptions ?? {};
  const deliveryOptions: readonly CliOnlyOption[] = Object.entries({
    ...(evidenceDelivery
      ? {
          detail:
            viewDelivery?.viewSelectsSummary === true
              ? analysisEvidenceDeliveryOptions.detail.unwrap().optional()
              : analysisEvidenceDeliveryOptions.detail,
          evidence_output: analysisEvidenceDeliveryOptions.evidence_output,
        }
      : {}),
    ...(viewDelivery === undefined
      ? {}
      : {
          view: z.string().optional().describe(viewOptionHelp(viewDelivery)),
        }),
  }).map(describeCliOnlyOption);
  const sessionTarget = describeSessionTarget(projection.sessionTarget);
  const keys = [
    DOCUMENT_KEY,
    ...(sessionTarget === undefined
      ? []
      : [sessionTarget.key, ...sessionTarget.options.map(({ key }) => key)]),
    ...Object.keys(cliOptions),
    ...deliveryOptions.map(({ key }) => key),
  ];
  if (new Set(keys).size !== keys.length)
    throw new Error(`${contract.name} projects two fields to one CLI key`);
  const documentRefusals: Readonly<Record<string, string>> = {
    ...Object.fromEntries(
      Object.entries(omitted).map(([field, reason]) => [
        field,
        `${field} is not accepted by this command: ${reason}`,
      ]),
    ),
    ...Object.fromEntries(
      Object.entries(flagged).map(([field, key]) => [
        field,
        `${field} is not accepted in the document: pass --${key} beside it`,
      ]),
    ),
  };
  return {
    command: projectedCommand(contract, projection.command),
    description: projection.description,
    contract,
    key: DOCUMENT_KEY,
    documentDescription: projection.document,
    content: getEvidenceInputContract(admitted).frameSchema,
    callerPaths,
    omitted,
    flagged,
    documentRefusals,
    deliveryOptions,
    admitDelivery: (values) =>
      evidenceDelivery
        ? admitDocumentDelivery(
            contract,
            viewDelivery === undefined
              ? undefined
              : { ...viewDelivery, schema: viewSchema },
            values,
          )
        : ok(undefined),
    sessionTarget,
    cliOnlyOptions: Object.entries(cliOptions).map(describeCliOnlyOption),
    cliOptionValues: (values) => selectCliOptionValues(cliOptions, values),
  };
};
