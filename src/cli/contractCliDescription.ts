import { z } from "zod";

import { cliCommandFor } from "../contracts/cliCommandNames.js";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import type { CallerInputPaths } from "../domain/evidence.js";
import { analysisInputErrorFromIssues } from "../domain/inputIssueProjection.js";
import { localPathStringSchema } from "../domain/localPath.js";
import { schemaAnnotations } from "../domain/schemaAnnotations.js";
import { isRecord } from "../kernel/isRecord.js";
import { err, ok, type Result } from "../domain/result.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";
import {
  analysisEvidenceDeliveryOptions,
  cliEvidenceDeliveryInputError,
} from "./analysisEvidenceDelivery.js";
import { parseCliJsonOption } from "./cliJsonOption.js";
import { getEvidenceInputContract } from "../domain/evidenceInputContract.js";
import { cliJsonCallerPathSchema } from "./cliJsonInput.js";
import { safeParseJson } from "../domain/safeJson.js";
import { cliDecimalField, cliDecimalShape, isNumericCore } from "./options.js";
import {
  selectCliAnalysisSelector,
  type CliSelectorKind,
} from "./analysisSelector.js";
import { optionFlagName } from "./optionFields.js";

/**
 * Framework-neutral CLI description of a tool contract. This module owns
 * which contract fields become positionals and options, their spellings,
 * help and argv admission, and the mapping back to contract input. A CLI
 * framework adapter (today `contractCommand.ts` for Incur) only renders it.
 */

/**
 * The parts of a tool contract that a CLI projection reads. A union input
 * shares every field except those the CLI delivery owns, such as a
 * `detail`-discriminated delivery.
 */
export interface ProjectedContract<Name extends string = string> {
  readonly name: Name;
  /** The contract names its own CLI command; see `ToolContract.cli`. */
  readonly cli?: true;
  readonly inputSchema:
    | z.ZodObject
    | z.ZodDiscriminatedUnion<readonly z.ZodObject[]>
    | z.ZodUnion<readonly z.ZodObject[]>;
  /**
   * The result schema. It declares which result positions are controls REA
   * recorded; without it the CLI renders no result controls.
   */
  readonly outputSchema?: z.ZodType;
}

/** A contract whose whole input a CLI command takes as one JSON document. */
export interface DocumentContract<Name extends string = string> {
  readonly name: Name;
  /** The contract names its own CLI command; see `ToolContract.cli`. */
  readonly cli?: true;
  readonly inputSchema: z.ZodType;
}

/**
 * The command a projection registers: the contract's own command, which the
 * contract declares with `cli: true` so the CLI inventory can be derived from
 * the registry, or the command a route names.
 */
const projectedCommand = (
  contract: DocumentContract,
  command: string | undefined,
): string => {
  if (command !== undefined) return command;
  if (contract.cli !== true)
    throw new Error(`${contract.name} does not declare its CLI command`);
  return cliCommandFor(contract.name);
};

/** A contract input field name, from any of its input branches. */
export type ContractField<Contract extends DocumentContract> =
  | (keyof z.input<Contract["inputSchema"]> & string)
  | (BranchKey<z.input<Contract["inputSchema"]>> & string);

type BranchKey<Input> = Input extends unknown ? keyof Input : never;

/** Check one decoded JSON input before the next input is read. */
export type CliJsonInputCheck = (
  value: unknown,
) => Result<unknown, AnalysisError>;

/** The value each JSON input check admitted, by contract field. */
export type CliCheckedJsonInputs<Checks> = {
  readonly [Key in keyof Checks]?: Checks[Key] extends (
    value: unknown,
  ) => Result<infer Value, AnalysisError>
    ? Value
    : never;
};

/** How one contract field is spelled on the CLI. */
export interface CliFieldProjection {
  /** Parameter key, in camelCase. Omit to use the camelCase contract field. */
  readonly name?: string;
  /** Single-character short flag. */
  readonly alias?: string;
  /** CLI help, when it differs from the contract field's description. */
  readonly description?: string;
}

/** How one member of a flattened object field is spelled on the CLI. */
export interface CliMemberProjection extends CliFieldProjection {
  /**
   * An absolute-path member the caller may spell relative to the working
   * directory. It is resolved before the contract sees it and kept as the
   * caller spelled it in `callerInputs`, under its dotted member path.
   */
  readonly callerPath?: true;
}

/**
 * The members of one flattened object: each an option, or a nested optional
 * object whose members are flattened in turn.
 */
export interface CliFlattenedMembers {
  readonly [member: string]:
    | CliMemberProjection
    | { readonly flatten: CliFlattenedMembers };
}

/** How one top-level contract field is spelled on the CLI. */
export interface CliContractFieldProjection extends CliFieldProjection {
  /**
   * The value an omitted option takes on the CLI, for a contract field that
   * has no default, such as the input branch a bare command selects. The
   * field must admit it.
   */
  readonly default?: string | number | boolean;
}

/**
 * The CLI spelling of one contract. Everything not listed here is derived
 * from the contract input schema: each field keeps its own schema, so the
 * CLI admits what the contract admits.
 */
export interface CliContractProjection<
  Field extends string,
  CliOptions extends CliOptionShape = CliOptionShape,
> {
  /**
   * Omitted for the contract's own command (`cli: true`), named after the
   * contract. A command routed to several contracts names itself here.
   */
  readonly command?: string;
  readonly description: string;
  /**
   * The input branches of a union contract this command takes, by the text
   * values of the field that tells them apart, such as the `operation`s a
   * sibling command runs instead. Each selected branch must be taken whole.
   * When one value is selected, the command fixes that field: argv does not
   * take it, and the contract input receives the value.
   */
  readonly inputBranches?: CliInputBranches<Field>;
  /** Fields taken as positional arguments, in argv order. */
  readonly positionals?: readonly Field[];
  /**
   * Positional selectors the caller may instead give with a named option,
   * for values that begin with a dash. The positional becomes optional;
   * equal values agree and different ones are refused before the target is
   * opened, as is neither when the field is required. The contract field
   * must refuse an empty selector.
   */
  readonly selectorOptions?: { readonly [Key in Field]?: CliSelectorOption };
  /**
   * Absolute-path fields, or lists of them, the caller may spell relative to
   * the working directory. The CLI admits each nonempty, NUL-free,
   * well-formed path, then resolves it with `absoluteCallerPath` before the
   * contract sees it.
   */
  readonly callerPaths?: readonly Field[];
  /**
   * Structured fields taken as one JSON text argument. The text is decoded
   * at argv parsing and then admitted by the contract field's own schema.
   */
  readonly jsonText?: readonly Field[];
  /**
   * Structured fields taken as JSON text that is decoded when the command
   * runs, each with its refusal when the text is not JSON. A required field
   * is a required option. The decoded input is then admitted by the
   * contract input before any target is opened.
   */
  readonly runtimeJson?: { readonly [Key in Field]?: string };
  /**
   * Structured fields taken as inline JSON or a JSON file path (`-` reads
   * stdin), for values that can exceed the host's command-line limit. The
   * command reads and decodes each when it runs, with its refusal when inline
   * text is not JSON; a file that cannot be read keeps its own failure. The
   * decoded input is then admitted by the contract input, as for
   * `runtimeJson`, before any target is opened.
   */
  readonly jsonInputs?: { readonly [Key in Field]?: string };
  /**
   * Checks of `jsonInputs` fields, run on each decoded input as soon as it
   * is read, in argv order, so a refused input stops the command before the
   * next input is read. Each check's value reaches the handler as
   * `checked`; the contract then admits the remaining input, so a checked
   * document is not walked and copied twice.
   */
  readonly jsonInputChecks?: { readonly [Key in Field]?: CliJsonInputCheck };
  /**
   * Nullable limits whose null ("all remaining") is spelled by a bare flag,
   * keyed by contract field. The limit option takes only a value; the flag
   * and the limit are mutually exclusive.
   */
  readonly nullFlags?: { readonly [Key in Field]?: CliNullFlag };
  /**
   * The operation analyzes the target an MCP session holds open, so the
   * target is not a contract field. The CLI takes it as the first positional,
   * `path`, and opens it before the operation runs on the contract input.
   */
  readonly sessionTarget?: CliSessionTarget;
  /**
   * Required contract fields that each take the Evidence a source contract
   * produces for one target, such as the two sides of a comparison. The CLI
   * takes each target as a positional, in this order, and runs the source on
   * every target with the same source options before the contract runs.
   */
  readonly evidenceTargets?: CliEvidenceTargets<Field>;
  /**
   * Object fields taken as one parameter per member, keyed by contract field
   * and then member; a member that is itself an object may be flattened in
   * turn. A member is required when it and each enclosing object are. Any
   * member given supplies each enclosing object with only the given members,
   * so the contract reports a missing companion member and an omitted
   * optional member stays omitted. A flattened field listed in `positionals`
   * takes its members as positionals there, in member order; it and each of
   * its members must be required.
   */
  readonly flatten?: { readonly [Key in Field]?: CliFlattenedMembers };
  readonly fields?: { readonly [Key in Field]?: CliContractFieldProjection };
  /**
   * Optional fields this one-shot command does not expose, each with the
   * reason. The contract's own default applies.
   */
  readonly omit?: { readonly [Key in Field]?: string };
  /**
   * Where the contract's cross-field rules first refuse a combination.
   * `argv` reports them as CLI validation errors naming CLI keys; by default
   * the service's contract parse reports them as an `invalid_request`.
   */
  readonly crossFieldRules?: "argv";
  /**
   * The command delivers complete Evidence or a summary saved beside a
   * bundle: it adds `--detail` and `--evidence_output`. A contract `detail`
   * field selects that delivery and is not passed to the analysis.
   */
  readonly evidenceDelivery?: true;
  /**
   * With `evidenceDelivery`, the contract `view` field selects the delivered
   * page. `--view` takes JSON text that is decoded when the command runs, and
   * the delivery is then checked against the contract input before any
   * target is opened.
   */
  readonly viewDelivery?: CliViewDelivery;
  /**
   * Options no contract field owns, keyed by their CLI key. Each is admitted
   * by its own schema and takes effect in the command handler, never in the
   * contract input; for example, an exit status chosen from the result.
   */
  readonly cliOptions?: CliOptions;
  /**
   * CLI-only options taken as positional arguments after the contract's
   * positionals, in this order, such as one target text the handler reads
   * as one of several contract fields. Their values reach the handler with
   * the other CLI-only values.
   */
  readonly cliPositionals?: readonly (keyof CliOptions & string)[];
  /**
   * Contract fields argv never supplies because the handler fills them from
   * CLI-only values, including required ones. The handler admits its
   * completed input with the contract, so the contract's own rules apply.
   */
  readonly handlerFields?: readonly Field[];
  /**
   * `dependentRequired` entries over CLI keys that the CLI-only options add
   * to the contract's own. Help and `--schema` advertise them; the handler
   * enforces them.
   */
  readonly cliOptionDependencies?: Readonly<
    Partial<Record<keyof CliOptions & string, readonly string[]>>
  >;
  /**
   * A CLI-only option whose values select another contract with the same
   * CLI projection, such as `--kind` choosing which inventory to search.
   * Other values, including the option's default, select the registered
   * contract.
   */
  readonly operationBy?: CliOperationChoice<keyof CliOptions & string>;
  /**
   * Optional top-level fields taken together as one JSON object option,
   * keyed by the option's CLI key, such as a selection whose members are
   * each a contract field. The text is decoded when the command runs, with
   * the group's refusal when it is not a JSON object; a member must be one
   * of the group's fields, and the contract admits each member's value as
   * that field. The grouped fields are not otherwise exposed.
   */
  readonly fieldGroups?: Readonly<Record<string, CliFieldGroup<Field>>>;
}

/** Contract fields one CLI option takes as the members of a JSON object. */
export interface CliFieldGroup<Field extends string = string> {
  readonly fields: readonly [Field, ...Field[]];
  readonly description: string;
  /** The refusal for text that is not a JSON object. */
  readonly invalidJson: string;
}

/** The input branches one command takes, by their discriminating values. */
export interface CliInputBranches<Field extends string = string> {
  readonly field: Field;
  readonly values: readonly [string, ...string[]];
}

/** Contracts a CLI-only option selects in place of the registered one. */
export interface CliOperationChoice<Option extends string = string> {
  readonly option: Option;
  readonly contracts: Readonly<Record<string, ProjectedContract>>;
}

/** Schemas of the CLI-only options of one command, keyed by CLI key. */
export type CliOptionShape = Readonly<Record<string, z.ZodType>>;

/** Parsed values of the CLI-only options of one command. */
export type CliOptionValues<CliOptions extends CliOptionShape> = {
  readonly [Key in keyof CliOptions]: z.output<CliOptions[Key]>;
};

/** The target an operation runs on, which an MCP session holds open. */
export interface CliSessionTarget {
  /** Help for the target positional. */
  readonly description: string;
  /**
   * Fields of the contract an MCP client opens the target with, taken as
   * options. They are admitted by that contract's input, with the target as
   * its `path`, before the target is opened.
   */
  readonly open?: CliTargetOpening;
}

/** The opening contract's fields a command takes as options. */
export interface CliTargetOpening {
  readonly contract: {
    readonly name: string;
    readonly inputSchema: z.ZodObject;
  };
  readonly fields: Readonly<Record<string, CliOpeningFieldProjection>>;
}

/** How one opening field is spelled on the CLI. */
export interface CliOpeningFieldProjection extends CliFieldProjection {
  /** The values this command admits: a subset of the field's enum. */
  readonly values?: readonly [string, ...string[]];
  /**
   * A local path the caller may spell relative to the working directory.
   * It is admitted resolved and passed on as the caller spelled it, like the
   * target itself.
   */
  readonly callerPath?: true;
}

/** An option that supplies one field of the opening contract. */
export interface ContractCliOpeningOption {
  readonly field: string;
  readonly key: string;
  readonly description: string | undefined;
  readonly schema: z.ZodType;
  /** Passed on as the caller spelled it once its resolved form is admitted. */
  readonly callerPath: boolean;
}

/** The described session target of a contract command. */
export interface ContractCliSessionTarget {
  /** The positional key, taken before every other positional. */
  readonly key: string;
  readonly schema: z.ZodType;
  /** The contract that opens the target, when the command takes its fields. */
  readonly opening: string | undefined;
  /** Options that supply fields of the opening contract. */
  readonly options: readonly ContractCliOpeningOption[];
  /**
   * The opening fields the parsed options select, in contract spelling,
   * admitted by the opening contract with the target as its `path`.
   * Issues name CLI keys.
   */
  readonly admitOpening: (
    operation: string,
    values: Readonly<Record<string, unknown>>,
  ) => Result<Readonly<Record<string, unknown>>, AnalysisInputError>;
}

/** The CLI key of a session target, which no contract field supplies. */
const SESSION_TARGET_KEY = "path";

/**
 * Contract fields each supplied by the source contract's Evidence for one
 * target. The source fields are its options; each target is admitted by the
 * source input as its `path`.
 */
export interface CliEvidenceTargets<Field extends string> {
  /** The target positional of each field, in argv order. */
  readonly fields: {
    readonly [Key in Field]?: CliFieldProjection & {
      /** Help for the target positional. */
      readonly description: string;
    };
  };
  readonly source: CliTargetOpening;
}

/** One described Evidence target positional. */
export interface ContractCliEvidenceTarget {
  /** The contract field its source Evidence supplies. */
  readonly field: string;
  readonly key: string;
  readonly schema: z.ZodType;
}

/** The described Evidence targets of a contract command. */
export interface ContractCliEvidenceTargets {
  /** The source contract each target runs. */
  readonly source: string;
  readonly targets: readonly ContractCliEvidenceTarget[];
  /** Options that supply fields of the source contract. */
  readonly options: readonly ContractCliOpeningOption[];
  /**
   * Each source contract field this command takes as an option, with that
   * option's flag, so a source failure's control names it.
   */
  readonly sourceFlags: Readonly<Record<string, string>>;
  /**
   * The source fields the parsed options select, in contract spelling,
   * admitted by the source input with each target as its `path`. Issues
   * name CLI keys.
   */
  readonly admitSource: (
    operation: string,
    values: Readonly<Record<string, unknown>>,
  ) => Result<Readonly<Record<string, unknown>>, AnalysisInputError>;
}

/** A bare flag that sets a nullable contract field to null. */
export interface CliNullFlag {
  readonly key: string;
  readonly description: string;
}

/** How a contract command takes its `view` selection. */
export interface CliViewDelivery {
  /** The refusal when `--view` is not JSON. */
  readonly invalidJson: string;
  /** Added to the selection when the contract's view does not name its kind. */
  readonly kind?: AnalysisViewRequest["kind"];
  /**
   * `--detail` has no default: a view selects summary delivery, and complete
   * applies otherwise, as in the contract.
   */
  readonly viewSelectsSummary?: true;
}

/** Help for `--view`, which names the delivery it needs. */
const viewOptionHelp = (viewDelivery: CliViewDelivery): string =>
  viewDelivery.viewSelectsSummary === true
    ? "JSON page selection; selects summary delivery, which requires --evidence_output"
    : "JSON page selection; requires --detail summary and --evidence_output";

/** A CLI option with no contract field, such as `--evidence_output`. */
export interface CliOnlyOption {
  readonly key: string;
  readonly description: string | undefined;
  readonly schema: z.ZodType;
}

/** The Evidence delivery a command invocation selected. */
export interface CliEvidenceDeliveryChoice {
  readonly detail: "complete" | "summary";
  readonly evidenceOutput: string | undefined;
  /** The admitted view, for a projection with `viewDelivery`. */
  readonly view?: AnalysisViewRequest;
}

/** The named option of a positional selector. */
export interface CliSelectorOption {
  /** The option key; its flag is the kebab-case spelling. */
  readonly name: string;
  readonly description: string;
  /** How the two spellings agree; `text` by default. */
  readonly kind?: CliSelectorKind;
  /**
   * The command needs a selector although the contract admits omission,
   * such as a one-shot command that has no current position to fall back on.
   */
  readonly required?: true;
  /**
   * A second named option that spells the same selector in another
   * coordinate system, such as a file offset for a procedure. Its value is
   * mapped to the selector's text and must agree with the other spellings.
   */
  readonly alternative?: CliSelectorAlternative;
}

/** Another option spelling a selector, mapped to the selector's text. */
export interface CliSelectorAlternative {
  /** The option key; its flag is the kebab-case spelling. */
  readonly name: string;
  readonly description: string;
  /** The option's own argv grammar. */
  readonly schema: z.ZodType<string>;
  /** The selector text this value selects. */
  readonly selects: (value: string) => string;
}

/** The described alternative option of a positional selector. */
export interface ContractCliSelectorAlternative {
  readonly key: string;
  /** The key of the option's parsed value. */
  readonly valueKey: string;
  readonly schema: z.ZodType;
  readonly selects: (value: string) => string;
}

/** The described named option of a positional selector. */
export interface ContractCliSelectorOption {
  readonly key: string;
  /**
   * The key of the option's parsed value, beside the positional's own
   * value, which may share the option's key.
   */
  readonly valueKey: string;
  readonly description: string;
  readonly schema: z.ZodType;
  readonly kind: CliSelectorKind;
  /** Neither spelling may be omitted. */
  readonly required: boolean;
  /** Another option spelling the same selector, if any. */
  readonly alternative: ContractCliSelectorAlternative | undefined;
}

/** One positional argument or option of a contract command. */
export interface ContractCliParameter {
  /** The contract input field this parameter supplies. */
  readonly field: string;
  /** camelCase key; an option's flag is its kebab-case spelling. */
  readonly key: string;
  readonly positional: boolean;
  readonly alias: string | undefined;
  readonly description: string | undefined;
  /**
   * Admission of the parsed argv value: the contract field's own schema,
   * with decimal integer tokens and caller-relative paths admitted.
   */
  readonly schema: z.ZodType;
  /**
   * The contract transforms this field; argv admits its inbound text and
   * the contract refuses or normalizes it on admission.
   */
  readonly inbound: boolean;
  /** A bare flag sets true; it takes no value. */
  readonly booleanFlag: boolean;
  /** The value an omitted option takes on the CLI where the contract has no default. */
  readonly cliDefault: string | number | boolean | undefined;
  /** The option may repeat; each occurrence adds one array element. */
  readonly repeatable: boolean;
  /** Integer values are spelled as decimal digits only. */
  readonly decimal: boolean;
  /** Resolved with `absoluteCallerPath` before the contract sees it. */
  readonly callerPath: boolean;
  /** The value is JSON text decoded into the contract field. */
  readonly jsonText: boolean;
  /** Selects CLI Evidence delivery and is not analysis input. */
  readonly delivery: boolean;
  /**
   * A delivery view as JSON text, decoded when the command runs and admitted
   * with the delivery by the contract input.
   */
  readonly viewSelection: boolean;
  /**
   * The refusal for text that is not JSON, when the value is JSON text
   * decoded when the command runs; undefined otherwise.
   */
  readonly runtimeJson: string | undefined;
  /**
   * The text may name a JSON file, which the command reads before the
   * parameters are admitted, so `admit` receives the decoded value.
   */
  readonly jsonInput: boolean;
  /** Checks the decoded JSON input as soon as it is read, if declared. */
  readonly checkJsonInput: CliJsonInputCheck | undefined;
  /** The bare flag that sets this nullable field to null, if any. */
  readonly nullFlag: string | undefined;
  /**
   * The member path within the object field this option supplies, if
   * flattened: one member, or more for a nested object.
   */
  readonly member: readonly string[] | undefined;
  /** The named option of a positional selector, if any. */
  readonly selectorOption: ContractCliSelectorOption | undefined;
  /**
   * The top-level contract fields this JSON object option supplies as its
   * members, for a field group; `field` is then the group's CLI key, not a
   * contract field. Undefined otherwise.
   */
  readonly group: readonly string[] | undefined;
}

/** The contract input and delivery one invocation selected. */
export interface ContractCliAdmission {
  readonly input: Record<string, unknown>;
  /**
   * The contract's parse of the whole input, when admission decoded JSON at
   * run time or argv supplied every contract field and the input conforms;
   * undefined otherwise.
   */
  readonly parsed: unknown;
  /**
   * The contract's parse of an argv-supplied whole input, or its refusal,
   * computed on first call and then reused. Admission leaves a refusal to
   * the handler, whose workflow owns how a nonconforming input is reported;
   * undefined when argv does not supply the whole input.
   */
  readonly parseWholeInput:
    | (() => Result<unknown, AnalysisInputError>)
    | undefined;
  /** The admitted delivery, for a projection with `evidenceDelivery`. */
  readonly delivery: CliEvidenceDeliveryChoice | undefined;
}

/** One cross-field refusal, naming CLI keys. */
export interface ContractCliIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly issue: z.core.$ZodIssue;
}

/** A complete, framework-neutral CLI command derived from one contract. */
export interface ContractCliDescription {
  readonly command: string;
  readonly description: string;
  readonly contract: ProjectedContract;
  /**
   * Each contract input field's own schema. In a union input, a field the
   * delivery owns admits the value of any branch.
   */
  readonly fields: Readonly<Record<string, z.ZodType>>;
  readonly parameters: readonly ContractCliParameter[];
  /** Options after the contract parameters that no contract field owns. */
  readonly cliOnlyOptions: readonly CliOnlyOption[];
  /** Positionals after the contract's own that no contract field owns. */
  readonly cliPositionals: readonly CliOnlyOption[];
  /** Contract fields the command does not expose, with the reason. */
  readonly omitted: Readonly<Record<string, string>>;
  /** Contract fields the handler fills from CLI-only values. */
  readonly handlerFields: readonly string[];
  /** Contract fields the selected input branch fixes, with their values. */
  readonly fixedFields: Readonly<Record<string, string>>;
  /** Object-level JSON Schema constraints, renamed to CLI keys. */
  readonly optionConstraints: Readonly<Record<string, unknown>> | undefined;
  /**
   * The contract's cross-field rules over parsed option values, when the
   * projection refuses them at argv parsing; undefined otherwise.
   */
  readonly checkOptions:
    | ((
        options: Readonly<Record<string, unknown>>,
      ) => readonly ContractCliIssue[])
    | undefined;
  /**
   * Map parsed values, keyed by parameter key, to the contract input. Values
   * of run-time JSON parameters must already be decoded.
   */
  readonly toContractInput: (
    values: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown>;
  /** Each caller-path field as the caller spelled it, before resolution. */
  readonly callerInputs: (
    values: Readonly<Record<string, unknown>>,
  ) => CallerInputPaths;
  /** The parsed values of the projection's CLI-only options. */
  readonly cliOptionValues: (
    values: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
  /**
   * The session target positional, taken before the contract positionals,
   * when the operation runs on a target the CLI opens; undefined otherwise.
   */
  readonly sessionTarget: ContractCliSessionTarget | undefined;
  /**
   * The Evidence target positionals, taken before the contract positionals,
   * when source Evidence supplies contract fields; undefined otherwise.
   */
  readonly evidenceTargets: ContractCliEvidenceTargets | undefined;
  /**
   * Contract fields the CLI spells differently, so input issues reported
   * after argv parsing can name the CLI key, and the flag of each contract
   * field (or `field.member`) the command takes as an option, so a failure
   * that names a per-call control can name the flag that sets it. Each field
   * of a field group maps to the group's option, and a positional selector
   * to its named option.
   */
  readonly inputBinding: {
    readonly operation: string;
    readonly fields: Readonly<Record<string, string>>;
    readonly flags: Readonly<Record<string, string>>;
  };
  /** The command adds `--detail` and `--evidence_output`. */
  readonly evidenceDelivery: boolean;
  /**
   * Map values decoded by `admitDeliveryOptions` and the JSON input reader
   * to the contract input and selected delivery. An input or delivery that
   * is not admitted is refused before any target is opened.
   */
  readonly admit: (
    values: Readonly<Record<string, unknown>>,
  ) => Result<ContractCliAdmission, AnalysisInputError>;
  /**
   * Refuse inline JSON options and a delivery the options cannot select,
   * before any JSON input is read, so an invalid invocation never waits on a
   * file or stdin. Return the decoded options for the input reader and `admit`;
   * `admit` still checks the admitted view with the input.
   */
  readonly admitDeliveryOptions: (
    values: Readonly<Record<string, unknown>>,
  ) => Result<Record<string, unknown>, AnalysisInputError>;
}

/** One contract from a contract group, keeping its exact schema types. */
export const contractNamed = <
  Contracts extends readonly { readonly name: string }[],
  Name extends Contracts[number]["name"],
>(
  contracts: Contracts,
  name: Name,
): Extract<Contracts[number], { readonly name: Name }> => {
  const contract = contracts.find(
    (
      candidate,
    ): candidate is Extract<Contracts[number], { readonly name: Name }> =>
      candidate.name === name,
  );
  if (contract === undefined) throw new Error(`Missing tool contract: ${name}`);
  return contract;
};

const camelCase = (field: string): string =>
  field.replaceAll(/_([a-z0-9])/gu, (_, letter: string) =>
    letter.toUpperCase(),
  );

/** The contract object admits this field's key being absent. */
const admitsOmission = (field: z.ZodType): boolean =>
  z.object({ value: field }).safeParse({}).success;

const isWrapper = (value: z.ZodType) =>
  value instanceof z.ZodOptional ||
  value instanceof z.ZodExactOptional ||
  value instanceof z.ZodDefault ||
  value instanceof z.ZodPrefault ||
  value instanceof z.ZodNullable ||
  value instanceof z.ZodReadonly;

const core = (value: z.ZodType): z.ZodType => {
  let current = value;
  while (isWrapper(current)) current = current.unwrap() as z.ZodType;
  return current;
};

/**
 * The description of a field, read through wrappers such as `.optional()`:
 * zod does not carry a wrapped schema's description to its wrapper, and the
 * advertised JSON Schema shows the wrapped description.
 */
const describedThroughWrappers = (value: z.ZodType): string | undefined => {
  let current = value;
  while (current.description === undefined && isWrapper(current))
    current = current.unwrap() as z.ZodType;
  return current.description;
};

/**
 * JSON text for a structured contract field. Argv carries text; the decoded
 * value is admitted by the contract field itself, so `--schema` advertises
 * the contract's structure.
 */
const jsonTextField = (declared: z.ZodType, flag: string): z.ZodType => {
  const value =
    declared instanceof z.ZodOptional || declared instanceof z.ZodExactOptional
      ? (declared.unwrap() as z.ZodType)
      : declared;
  const expected =
    core(value) instanceof z.ZodObject ? "a JSON object" : "valid JSON";
  const decoded = z
    .string()
    .transform((text, context) => {
      const parsed = safeParseJson(text);
      if (parsed.ok) return parsed.value;
      context.addIssue({
        code: "custom",
        message: `${flag} must be ${expected}`,
      });
      return z.NEVER;
    })
    .pipe(value);
  const admitted = admitsOmission(declared) ? decoded.optional() : decoded;
  return declared.description === undefined
    ? admitted
    : admitted.describe(declared.description);
};

const assertArgvField = (
  contract: string,
  field: string,
  schema: z.ZodType,
) => {
  const current = core(schema);
  // A union of text forms, such as `auto` or a provider ID, is one token.
  const text = (member: z.ZodType): boolean =>
    member instanceof z.ZodString ||
    member instanceof z.ZodEnum ||
    (member instanceof z.ZodLiteral &&
      [...member.values].every((value) => typeof value === "string"));
  const scalar =
    current instanceof z.ZodString ||
    isNumericCore(current) ||
    current instanceof z.ZodBoolean ||
    current instanceof z.ZodEnum ||
    (current instanceof z.ZodUnion &&
      (current.options as readonly z.ZodType[]).every(text));
  const element =
    current instanceof z.ZodArray ? core(current.element as z.ZodType) : null;
  if (
    !scalar &&
    !(
      element instanceof z.ZodString ||
      element instanceof z.ZodEnum ||
      element instanceof z.ZodNumber
    )
  )
    throw new Error(
      `${contract}.${field} has no argv projection; declare one before exposing it on the CLI`,
    );
};

/**
 * Argv cannot carry an explicit undefined, so an exact-optional field admits
 * the same values as an optional one. Renderers such as Incur's help read
 * boolean flags and enum choices only through `optional`.
 */
/**
 * The inbound view of a transformed contract field, such as an endpoint or
 * an origin list the contract normalizes: argv carries the text the
 * contract transforms when it admits the input, as tools/list advertises
 * it. Undefined when the field has no transform.
 */
const inboundView = (field: z.ZodType): z.ZodType | undefined => {
  const inbound = (schema: z.ZodType): z.ZodType | undefined => {
    if (schema instanceof z.ZodPipe && schema.out instanceof z.ZodTransform)
      return inbound(schema.in as z.ZodType) ?? (schema.in as z.ZodType);
    if (schema instanceof z.ZodArray) {
      const element = inbound(schema.element as z.ZodType);
      return element === undefined
        ? undefined
        : (schema.clone({ ...schema.def, element }) as z.ZodType);
    }
    return undefined;
  };
  const view = inbound(core(field));
  if (view === undefined) return undefined;
  // The contract applies its own default when it admits the input.
  const optional = admitsOmission(field) ? view.optional() : view;
  const description = field.description ?? view.description;
  return description === undefined ? optional : optional.describe(description);
};

/**
 * The argv schema of a field: a number, or each element of an array of
 * numbers, takes decimal tokens only. An array keeps its own bounds.
 */
const argvDecimal = (field: z.ZodType): z.ZodType => {
  const array = core(field);
  if (
    !(array instanceof z.ZodArray) ||
    !(core(array.element as z.ZodType) instanceof z.ZodNumber)
  )
    return cliDecimalShape({ field }).field;
  if (field instanceof z.ZodDefault)
    throw new Error("A defaulted number array has no argv projection");
  const decimal = new z.ZodArray({
    ...array._zod.def,
    element: cliDecimalField(array.element as z.ZodType),
  });
  const admitted = admitsOmission(field) ? decimal.optional() : decimal;
  return field.description === undefined
    ? admitted
    : admitted.describe(field.description);
};

const argvOptional = (field: z.ZodType): z.ZodType => {
  if (!(field instanceof z.ZodExactOptional)) return field;
  const optional = (field.unwrap() as z.ZodType).optional();
  return field.description === undefined
    ? optional
    : optional.describe(field.description);
};

const OBJECT_CONSTRAINTS = ["dependentRequired", "if", "then", "else"] as const;

/** Contract-level presentation that CLI help states in its own words. */
const ROOT_ANNOTATIONS: ReadonlySet<string> = new Set([
  "description",
  "title",
  "examples",
]);

/** Rename the field names inside the object constraints the contract advertises. */
const renameConstraint = (
  contract: string,
  value: unknown,
  rename: (field: string) => string,
): unknown => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${contract} has an unsupported object constraint`);
  return Object.fromEntries(
    Object.entries(value).map(([keyword, inner]) => {
      if (keyword === "required" && Array.isArray(inner))
        return [keyword, inner.map((field: string) => rename(field))];
      if (keyword === "properties" && typeof inner === "object" && inner)
        return [
          keyword,
          Object.fromEntries(
            Object.entries(inner).map(([field, schema]) => [
              rename(field),
              schema,
            ]),
          ),
        ];
      throw new Error(
        `${contract} object constraint keyword ${keyword} has no CLI projection`,
      );
    }),
  );
};

const projectObjectConstraints = (
  contract: ProjectedContract,
  rename: (field: string) => string,
  discriminatorFields: ReadonlySet<string>,
  cliOptionDependencies: Readonly<Record<string, readonly string[]>>,
  nullFlagLimits: readonly (readonly [flag: string, limit: string])[],
): Record<string, unknown> | undefined => {
  const metadata = contract.inputSchema.meta() ?? {};
  for (const keyword of Object.keys(metadata))
    if (
      !ROOT_ANNOTATIONS.has(keyword) &&
      !(OBJECT_CONSTRAINTS as readonly string[]).includes(keyword)
    )
      throw new Error(
        `${contract.name} input keyword ${keyword} has no CLI projection`,
      );
  // A root discriminator is checked with the delivery, left to the contract
  // when the projection omits the discriminator, or is the option that
  // selects the input branch.
  const { rootDiscriminator } = schemaAnnotations(contract.inputSchema) ?? {};
  if (
    rootDiscriminator !== undefined &&
    !discriminatorFields.has(rootDiscriminator)
  )
    throw new Error(
      `${contract.name} root discriminator ${rootDiscriminator} has no CLI projection`,
    );
  const projected: Record<string, unknown> = {};
  for (const keyword of OBJECT_CONSTRAINTS) {
    const value = metadata[keyword];
    if (value === undefined) continue;
    projected[keyword] =
      keyword === "dependentRequired"
        ? Object.fromEntries(
            Object.entries(value as Record<string, readonly string[]>).map(
              ([field, required]) => [rename(field), required.map(rename)],
            ),
          )
        : renameConstraint(contract.name, value, rename);
  }
  if (Object.keys(cliOptionDependencies).length > 0)
    projected.dependentRequired = {
      ...(projected.dependentRequired as object | undefined),
      ...cliOptionDependencies,
    };
  if (nullFlagLimits.length > 1)
    throw new Error(`${contract.name} has more than one null flag`);
  for (const [flag, limit] of nullFlagLimits)
    projected.not = {
      required: [flag, limit],
      properties: { [flag]: { const: true } },
    };
  return Object.keys(projected).length === 0 ? undefined : projected;
};

/**
 * Each input field's schema. Branches of a union input must share each field
 * the CLI takes as an argument; only delivery-owned fields, and omitted
 * fields the CLI never supplies, may differ, and they admit any branch's
 * value here. The delivery is then checked against the whole union.
 */
/**
 * A boolean whose `true` and `false` literals each select one input branch,
 * such as whether to capture script sources, is one flag. Omission takes the
 * default of the branch that admits it; the contract selects the branch when
 * it admits the input.
 */
const branchSelectingFlag = (
  branches: readonly (z.ZodType | undefined)[],
): z.ZodType | undefined => {
  const values = branches.map((branch) => {
    const value = branch === undefined ? undefined : core(branch);
    return value instanceof z.ZodLiteral && value.values.size === 1
      ? [...value.values][0]
      : undefined;
  });
  if (
    values.some((value) => typeof value !== "boolean") ||
    new Set(values).size !== 2
  )
    return undefined;
  const omissions = branches.filter((branch) => admitsOmission(branch!));
  if (omissions.length > 1) return undefined;
  const flag = z.boolean();
  return omissions.length === 0
    ? flag
    : flag.default(omissions[0]!.parse(undefined) as boolean);
};

/** The text values a literal or enum field admits, or undefined for other fields. */
const textValues = (
  field: z.ZodType | undefined,
): readonly string[] | undefined => {
  const value = field === undefined ? undefined : core(field);
  const values =
    value instanceof z.ZodLiteral
      ? [...value.values]
      : value instanceof z.ZodEnum
        ? value.options
        : undefined;
  return values?.every((entry) => typeof entry === "string")
    ? values
    : undefined;
};

/**
 * A field every input branch declares as distinct text values, a literal in
 * one branch or an enum in another, such as `action` or `operation`: the
 * option names the branch it selects. Omission takes the default of the one
 * branch that admits it.
 */
const branchSelectingChoice = (
  branches: readonly (z.ZodType | undefined)[],
): z.ZodType | undefined => {
  const valueSets = branches.map(textValues);
  if (valueSets.some((values) => values === undefined)) return undefined;
  const values = valueSets.flatMap((values) => values!);
  const omissions = branches.filter((branch) => admitsOmission(branch!));
  if (new Set(values).size !== values.length || omissions.length > 1)
    return undefined;
  const choice = z.enum(values as [string, ...string[]]);
  const omitted = omissions[0]?.parse(undefined) as string | undefined;
  const chosen =
    omissions.length === 0
      ? choice
      : omitted === undefined
        ? choice.optional()
        : choice.default(omitted);
  const described = branches.find((branch) => branch!.description);
  return described === undefined
    ? chosen
    : chosen.describe(described.description!);
};

/**
 * A field only some input branches declare, with one schema there. The CLI
 * takes it as an optional option without a parse-time default, so another
 * branch never receives it; the selected branch's contract parse applies
 * its default, or refuses the field when that branch does not declare it.
 */
const branchOnlyField = (
  branches: readonly (z.ZodType | undefined)[],
): z.ZodType | undefined => {
  const declared = branches.filter(
    (branch): branch is z.ZodType => branch !== undefined,
  );
  const [first] = declared;
  if (
    first === undefined ||
    declared.length === branches.length ||
    declared.some((branch) => branch !== first)
  )
    return undefined;
  if (admitsOmission(first)) return withoutDefault(first);
  const optional = first.optional();
  return first.description === undefined
    ? optional
    : optional.describe(first.description);
};

/**
 * An option that must stay omitted when the caller omits it, because the
 * input branch or route the caller selects applies its own default on
 * admission. Help and `--schema` still state the default through the
 * schema metadata.
 */
export const withoutDefault = (schema: z.ZodType): z.ZodType => {
  if (!(schema instanceof z.ZodDefault)) return schema;
  const value: unknown = schema.parse(undefined);
  const omittable = (schema.removeDefault() as z.ZodType).optional();
  return omittable.meta({ ...schema.meta(), default: value });
};

/**
 * The union branches a projection takes, and the field it fixes when it
 * selects one value.
 */
const selectInputBranches = (
  contract: ProjectedContract,
  selection: CliInputBranches | undefined,
): {
  readonly inputSchema: ProjectedContract["inputSchema"];
  readonly fixed: readonly [field: string, value: string] | undefined;
} => {
  const schema = contract.inputSchema;
  if (selection === undefined) return { inputSchema: schema, fixed: undefined };
  const { field, values } = selection;
  if (schema instanceof z.ZodObject)
    throw new Error(`${contract.name} has one input branch`);
  const covered = new Set<string>();
  const selected = schema.options.filter((branch) => {
    const admitted = textValues(
      (branch.shape as Record<string, z.ZodType>)[field],
    );
    if (admitted === undefined)
      throw new Error(`${contract.name}.${field} does not tell branches apart`);
    const chosen = admitted.filter((value) => values.includes(value));
    if (chosen.length > 0 && chosen.length !== admitted.length)
      throw new Error(`${contract.name}.${field} would narrow an input branch`);
    for (const value of chosen) covered.add(value);
    return chosen.length > 0;
  });
  if (covered.size !== new Set(values).size)
    throw new Error(`${contract.name}.${field} selects no branch for a value`);
  return {
    inputSchema: selected.length === 1 ? selected[0]! : z.union(selected),
    fixed: values.length === 1 ? [field, values[0]] : undefined,
  };
};

const inputFields = (
  contract: ProjectedContract,
  unprojectedFields: ReadonlySet<string>,
): {
  readonly shape: Record<string, z.ZodType>;
  /** Fields whose value selects an input branch. */
  readonly selectors: ReadonlySet<string>;
} => {
  const schema = contract.inputSchema;
  if (schema instanceof z.ZodObject)
    return {
      shape: schema.shape as Record<string, z.ZodType>,
      selectors: new Set(),
    };
  const shapes = schema.options.map(
    (option) => option.shape as Record<string, z.ZodType>,
  );
  const names = new Set(shapes.flatMap((shape) => Object.keys(shape)));
  const selectors = new Set<string>();
  const shape = Object.fromEntries(
    [...names].map((field) => {
      const branches = shapes.map((shape) => shape[field]);
      const [first] = branches;
      if (branches.every((branch) => branch === first)) return [field, first!];
      const selector =
        branchSelectingFlag(branches) ?? branchSelectingChoice(branches);
      if (selector !== undefined) {
        selectors.add(field);
        return [field, selector];
      }
      const branchOnly = branchOnlyField(branches);
      if (branchOnly !== undefined) return [field, branchOnly];
      if (
        !unprojectedFields.has(field) ||
        branches.some((branch) => branch === undefined)
      )
        throw new Error(
          `${contract.name}.${field} differs between input branches and has no argv projection`,
        );
      return [field, z.union(branches as z.ZodType[])];
    }),
  );
  return { shape, selectors };
};

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
 * Describe the options that supply fields of an opening or source contract,
 * and admit what the caller selected with a target as that contract's
 * `path`. Each option admits its field's own schema, narrowed to the
 * projected values.
 */
const describeTargetOpening = (
  opening: CliTargetOpening | undefined,
): {
  readonly options: readonly ContractCliOpeningOption[];
  readonly admit: (
    operation: string,
    values: Readonly<Record<string, unknown>>,
    target: string,
  ) => Result<Readonly<Record<string, unknown>>, AnalysisInputError>;
} => {
  const opener = opening?.contract.name ?? "";
  const shape = (opening?.contract.inputSchema.shape ?? {}) as Record<
    string,
    z.ZodType
  >;
  const options: readonly ContractCliOpeningOption[] = Object.entries(
    opening?.fields ?? {},
  ).map(([field, projected]) => {
    const declared = shape[field];
    if (declared === undefined || field === SESSION_TARGET_KEY)
      throw new Error(`${opener} has no option field ${field}`);
    if (!admitsOmission(declared))
      throw new Error(`${opener}.${field} is required`);
    let schema: z.ZodType;
    if (projected.callerPath === true) {
      if (!(core(declared) instanceof z.ZodString))
        throw new Error(`${opener}.${field} is not a path`);
      schema = localPathStringSchema.optional();
    } else if (projected.values === undefined) {
      assertArgvField(opener, field, declared);
      schema = argvDecimal(argvOptional(declared));
    } else {
      for (const value of projected.values)
        if (!declared.safeParse(value).success)
          throw new Error(`${opener}.${field} does not admit ${value}`);
      schema = z.enum(projected.values).optional();
    }
    const description =
      projected.description ?? describedThroughWrappers(declared);
    if (description !== undefined) schema = schema.describe(description);
    return {
      field,
      key: projected.name ?? camelCase(field),
      description,
      schema,
      callerPath: projected.callerPath === true,
    };
  });
  const keyOf = new Map(options.map(({ field, key }) => [field, key]));
  const callerPaths: ReadonlySet<string> = new Set(
    options.flatMap(({ field, callerPath }) => (callerPath ? [field] : [])),
  );
  return {
    options,
    admit: (operation, values, target) => {
      if (opening === undefined) return ok({});
      const selected = Object.fromEntries(
        options.flatMap(({ field, key }) =>
          values[key] === undefined ? [] : [[field, values[key]]],
        ),
      );
      // The target itself was admitted as its positional.
      if (Object.keys(selected).length === 0) return ok({});
      const candidate = {
        ...Object.fromEntries(
          Object.entries(selected).map(([field, value]) => [
            field,
            callerPaths.has(field)
              ? absoluteCallerPath(value as string)
              : value,
          ]),
        ),
        [SESSION_TARGET_KEY]: absoluteCallerPath(target),
      };
      const admitted = opening.contract.inputSchema.safeParse(candidate);
      if (!admitted.success)
        return err(
          analysisInputErrorFromIssues(
            operation,
            admitted.error.issues.map((issue) => {
              const [field, ...rest] = issue.path;
              const key =
                typeof field === "string" ? keyOf.get(field) : undefined;
              return key === undefined
                ? issue
                : { ...issue, path: [key, ...rest] };
            }),
            selected,
          ),
        );
      const data = admitted.data as Readonly<Record<string, unknown>>;
      return ok(
        Object.fromEntries(
          Object.keys(selected).map((field) => [
            field,
            callerPaths.has(field) ? selected[field] : data[field],
          ]),
        ),
      );
    },
  };
};

/** Describe the target positional and its opening options. */
const describeSessionTarget = (
  target: CliSessionTarget | undefined,
): ContractCliSessionTarget | undefined => {
  if (target === undefined) return undefined;
  const { options, admit } = describeTargetOpening(target.open);
  return {
    key: SESSION_TARGET_KEY,
    schema: localPathStringSchema.describe(target.description),
    opening: target.open?.contract.name,
    options,
    admitOpening: (operation, values) =>
      admit(operation, values, values[SESSION_TARGET_KEY] as string),
  };
};

/**
 * Describe the Evidence target positionals of required contract fields and
 * the options of their shared source contract. Every target is admitted by
 * the source input, so a source option holds for each one.
 */
const describeEvidenceTargets = (
  contract: ProjectedContract,
  shape: Readonly<Record<string, z.ZodType>>,
  targets: CliEvidenceTargets<string> | undefined,
): ContractCliEvidenceTargets | undefined => {
  if (targets === undefined) return undefined;
  const { options, admit } = describeTargetOpening(targets.source);
  const described = Object.entries(targets.fields).flatMap(
    ([field, projected]) => {
      if (projected === undefined) return [];
      const declared = shape[field];
      if (declared === undefined)
        throw new Error(`${contract.name} has no input field ${field}`);
      if (admitsOmission(declared))
        throw new Error(`${contract.name}.${field} is not a required field`);
      return [
        {
          field,
          key: projected.name ?? camelCase(field),
          schema: localPathStringSchema.describe(projected.description),
        },
      ];
    },
  );
  if (described.length === 0)
    throw new Error(`${contract.name} declares no Evidence target`);
  return {
    source: targets.source.contract.name,
    targets: described,
    options,
    sourceFlags: Object.fromEntries(
      options.map(({ field, key }) => [field, `--${optionFlagName(key)}`]),
    ),
    admitSource: (operation, values) => {
      let admitted: Result<
        Readonly<Record<string, unknown>>,
        AnalysisInputError
      > = ok({});
      for (const { key } of described) {
        admitted = admit(operation, values, values[key] as string);
        if (!admitted.ok) return admitted;
      }
      return admitted;
    },
  };
};

/**
 * The delivery `--detail`, `--evidence_output` and `--view` select beside a
 * JSON document. The view is admitted by the contract's own `view` field; a
 * page is selected from a retained summary, so it needs summary delivery.
 */
const admitDocumentDelivery = (
  operation: string,
  viewDelivery: (CliViewDelivery & { readonly schema: z.ZodType }) | undefined,
  values: Readonly<Record<string, unknown>>,
): Result<CliEvidenceDeliveryChoice, AnalysisInputError> => {
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
    (view === undefined ? "complete" : "summary");
  const delivery: CliEvidenceDeliveryChoice = {
    detail,
    evidenceOutput: values.evidence_output as string | undefined,
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
  }).map(([key, schema]: [string, z.ZodType]) => ({
    key,
    description: schema.description,
    schema,
  }));
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
            contract.name,
            viewDelivery === undefined
              ? undefined
              : { ...viewDelivery, schema: viewSchema },
            values,
          )
        : ok(undefined),
    sessionTarget,
    cliOnlyOptions: Object.entries(cliOptions).map(([key, schema]) => ({
      key,
      description: schema.description,
      schema,
    })),
    cliOptionValues: (values) =>
      Object.fromEntries(
        Object.keys(cliOptions).flatMap((key) =>
          values[key] === undefined ? [] : [[key, values[key]]],
        ),
      ),
  };
};

/** Derive the CLI parameters of one contract from its input schema and projection. */
export const describeContractCommand = <
  Contract extends ProjectedContract,
  CliOptions extends CliOptionShape = CliOptionShape,
>(
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>, CliOptions>,
): ContractCliDescription => {
  const evidenceDelivery = projection.evidenceDelivery === true;
  const { viewDelivery } = projection;
  if (viewDelivery !== undefined && !evidenceDelivery)
    throw new Error(`${contract.name} view delivery requires evidenceDelivery`);
  const deliveryFields: ReadonlySet<string> = new Set(
    evidenceDelivery
      ? viewDelivery === undefined
        ? ["detail"]
        : ["detail", "view"]
      : [],
  );
  if (
    projection.sessionTarget !== undefined &&
    projection.evidenceTargets !== undefined
  )
    throw new Error(
      `${contract.name} takes both a session target and Evidence targets`,
    );
  const targetFields: ReadonlySet<string> = new Set(
    Object.keys(projection.evidenceTargets?.fields ?? {}),
  );
  const handlerFields: readonly string[] = projection.handlerFields ?? [];
  const branches = selectInputBranches(contract, projection.inputBranches);
  const fixedFields: ReadonlyMap<string, string> = new Map(
    branches.fixed === undefined ? [] : [branches.fixed],
  );
  // Fields argv never supplies: the delivery's, the omitted ones, those the
  // handler supplies with each target's source Evidence, those it fills
  // from CLI-only values, and the one the selected branch fixes.
  const unprojectedFields: ReadonlySet<string> = new Set([
    ...deliveryFields,
    ...Object.keys(projection.omit ?? {}),
    ...targetFields,
    ...handlerFields,
    ...fixedFields.keys(),
  ]);
  const { shape, selectors } = inputFields(
    { name: contract.name, inputSchema: branches.inputSchema },
    unprojectedFields,
  );
  if (viewDelivery !== undefined && !admitsOmission(shape.view ?? z.never()))
    throw new Error(`${contract.name} has no optional input field view`);
  const positionals: readonly string[] = projection.positionals ?? [];
  const selectorOptions: Readonly<
    Record<string, CliSelectorOption | undefined>
  > = projection.selectorOptions ?? {};
  for (const field of Object.keys(selectorOptions))
    if (!positionals.includes(field))
      throw new Error(`${contract.name}.${field} is not a positional selector`);
  const callerPaths: ReadonlySet<string> = new Set(
    projection.callerPaths ?? [],
  );
  const fieldProjections: Readonly<
    Record<string, CliContractFieldProjection | undefined>
  > = projection.fields ?? {};
  const jsonTextFields: ReadonlySet<string> = new Set(
    projection.jsonText ?? [],
  );
  const jsonInputFields: Readonly<Record<string, string | undefined>> =
    projection.jsonInputs ?? {};
  for (const field of Object.keys(jsonInputFields))
    if (Object.hasOwn(projection.runtimeJson ?? {}, field))
      throw new Error(`${contract.name}.${field} is JSON text and JSON input`);
  const jsonInputChecks: Readonly<
    Record<string, CliJsonInputCheck | undefined>
  > = projection.jsonInputChecks ?? {};
  for (const field of Object.keys(jsonInputChecks))
    if (!Object.hasOwn(jsonInputFields, field))
      throw new Error(
        `${contract.name}.${field} is checked but not a JSON input`,
      );
  const runtimeJsonFields: Readonly<Record<string, string | undefined>> = {
    ...projection.runtimeJson,
    ...jsonInputFields,
  };
  const nullFlags: Readonly<Record<string, CliNullFlag | undefined>> =
    projection.nullFlags ?? {};
  const omitted: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(projection.omit ?? {}).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  for (const field of [
    ...positionals,
    ...callerPaths,
    ...jsonTextFields,
    ...Object.keys(runtimeJsonFields),
    ...Object.keys(nullFlags),
    ...Object.keys(projection.flatten ?? {}),
    ...Object.keys(fieldProjections),
    ...Object.keys(omitted),
  ]) {
    if (!Object.hasOwn(shape, field))
      throw new Error(`${contract.name} has no input field ${field}`);
    if (targetFields.has(field))
      throw new Error(`${contract.name}.${field} is an Evidence target`);
    if (handlerFields.includes(field))
      throw new Error(`${contract.name}.${field} is filled by the handler`);
    if (fixedFields.has(field))
      throw new Error(`${contract.name}.${field} is fixed by its input branch`);
  }
  const fieldGroups: Readonly<Record<string, CliFieldGroup | undefined>> =
    projection.fieldGroups ?? {};
  const groupedFields = new Set<string>();
  const projectedFields = new Set([
    ...positionals,
    ...callerPaths,
    ...jsonTextFields,
    ...Object.keys(runtimeJsonFields),
    ...Object.keys(nullFlags),
    ...Object.keys(projection.flatten ?? {}),
    ...Object.keys(fieldProjections),
    ...Object.keys(omitted),
    ...unprojectedFields,
  ]);
  for (const group of Object.values(fieldGroups))
    for (const field of group?.fields ?? []) {
      if (!Object.hasOwn(shape, field))
        throw new Error(`${contract.name} has no input field ${field}`);
      if (projectedFields.has(field) || groupedFields.has(field))
        throw new Error(`${contract.name}.${field} is projected twice`);
      // The option may be omitted, so each member may be.
      if (!admitsOmission(shape[field]!))
        throw new Error(`${contract.name}.${field} is a required group member`);
      groupedFields.add(field);
    }
  for (const field of handlerFields) {
    if (!Object.hasOwn(shape, field))
      throw new Error(`${contract.name} has no input field ${field}`);
    if (targetFields.has(field))
      throw new Error(`${contract.name}.${field} is an Evidence target`);
  }
  for (const field of Object.keys(omitted))
    if (!admitsOmission(shape[field]!))
      throw new Error(`${contract.name}.${field} is required on the CLI`);

  const parameter = (field: string): ContractCliParameter => {
    const inbound = inboundView(shape[field]!);
    const declared = inbound ?? shape[field]!;
    const projected = fieldProjections[field];
    const callerPath = callerPaths.has(field);
    const delivery = deliveryFields.has(field);
    const viewSelection = delivery && field === "view";
    const jsonText = jsonTextFields.has(field);
    const runtimeJson = viewSelection
      ? viewDelivery?.invalidJson
      : runtimeJsonFields[field];
    const jsonInput = !viewSelection && Object.hasOwn(jsonInputFields, field);
    const nullFlag = nullFlags[field]?.key;
    const key = projected?.name ?? camelCase(field);
    let schema: z.ZodType;
    if (runtimeJson !== undefined) {
      // Argv requires the text of a required field; the contract admits
      // what it decodes to. Help and `--schema` show a contract default as
      // the JSON text that decodes to it. Empty text is neither JSON nor a
      // file path, so a JSON input refuses it before any input is read.
      const text = jsonInput ? z.string().min(1) : z.string();
      schema =
        declared instanceof z.ZodDefault
          ? text.default(JSON.stringify(declared.parse(undefined)))
          : admitsOmission(declared)
            ? text.optional()
            : text;
      if (viewSelection && viewDelivery !== undefined)
        schema = schema.describe(viewOptionHelp(viewDelivery));
    } else if (nullFlag !== undefined) {
      // The flag spells null, so the option itself takes only a value.
      if (!declared.safeParse(null).success)
        throw new Error(`${contract.name}.${field} does not admit null`);
      assertArgvField(contract.name, field, declared);
      schema = argvDecimal(core(declared).optional());
    } else if (delivery)
      schema =
        viewDelivery?.viewSelectsSummary === true
          ? analysisEvidenceDeliveryOptions.detail.unwrap().optional()
          : analysisEvidenceDeliveryOptions.detail;
    else if (jsonText) schema = jsonTextField(declared, optionFlagName(key));
    else if (callerPath) {
      const admitted =
        core(declared) instanceof z.ZodArray
          ? z.array(localPathStringSchema)
          : localPathStringSchema;
      schema = admitsOmission(declared) ? admitted.optional() : admitted;
    } else {
      assertArgvField(contract.name, field, declared);
      schema = argvDecimal(argvOptional(declared));
    }
    if (projected?.default !== undefined) {
      if (
        admitsOmission(declared) ||
        !declared.safeParse(projected.default).success
      )
        throw new Error(
          `${contract.name}.${field} cannot take the CLI default ${String(projected.default)}`,
        );
      const described = schema.description;
      schema = schema.default(projected.default as never);
      if (described !== undefined) schema = schema.describe(described);
    }
    const described =
      projected?.description ??
      schema.description ??
      describedThroughWrappers(declared);
    if (described !== undefined && described !== schema.description)
      schema = schema.describe(described);
    if (!delivery && projected?.default === undefined)
      schema = withoutDefault(schema);
    const description = schema.description ?? described;
    const value = core(declared);
    const selector = selectorOptions[field];
    let selectorOption: ContractCliSelectorOption | undefined;
    if (selector !== undefined) {
      if (!(value instanceof z.ZodString))
        throw new Error(`${contract.name}.${field} is not a text selector`);
      // A selector names one object. Its contract refuses an empty one, so
      // the CLI and MCP agree without a CLI-only rule.
      if (value.safeParse("").success)
        throw new Error(`${contract.name}.${field} admits an empty selector`);
      // Either spelling may supply the selector.
      schema = schema.optional();
      if (description !== undefined) schema = schema.describe(description);
      selectorOption = {
        key: selector.name,
        valueKey: `--${selector.name}`,
        description: selector.description,
        schema: schema.describe(selector.description),
        kind: selector.kind ?? "text",
        required: selector.required === true || !admitsOmission(declared),
        alternative:
          selector.alternative === undefined
            ? undefined
            : {
                key: selector.alternative.name,
                valueKey: `--${selector.alternative.name}`,
                schema: selector.alternative.schema
                  .optional()
                  .describe(selector.alternative.description),
                selects: selector.alternative.selects,
              },
      };
    }
    return {
      field,
      key,
      positional: positionals.includes(field),
      alias: projected?.alias,
      description,
      schema,
      inbound: inbound !== undefined,
      booleanFlag: value instanceof z.ZodBoolean,
      cliDefault: projected?.default,
      repeatable: value instanceof z.ZodArray,
      decimal: isNumericCore(value),
      callerPath,
      delivery,
      jsonText,
      viewSelection,
      runtimeJson,
      jsonInput,
      checkJsonInput: jsonInputChecks[field],
      nullFlag,
      member: undefined,
      selectorOption,
      group: undefined,
    };
  };
  const flattened: Readonly<Record<string, CliFlattenedMembers | undefined>> =
    projection.flatten ?? {};
  const memberParameters = (
    field: string,
    path: readonly string[],
    declared: z.ZodType,
    members: CliFlattenedMembers,
    enclosingRequired: boolean,
  ): ContractCliParameter[] => {
    const object = core(declared);
    const name = [field, ...path].join(".");
    if (!(object instanceof z.ZodObject))
      throw new Error(`${contract.name}.${name} is not an object`);
    // A member is required when it and every enclosing object are.
    const required = enclosingRequired && !admitsOmission(declared);
    // A flattened positional field takes each member as a positional, in
    // member order, so every member must be required.
    const positional = path.length === 0 && positionals.includes(field);
    if (positional && !required)
      throw new Error(
        `${contract.name}.${name} is an optional positional object`,
      );
    const memberShape = object.shape as Record<string, z.ZodType>;
    if (
      Object.keys(members).toSorted().join() !==
      Object.keys(memberShape).toSorted().join()
    )
      throw new Error(`${contract.name}.${name} flattens other members`);
    const memberParameterList = Object.entries(memberShape).flatMap(
      ([member, memberDeclared]) => {
        const projected = members[member]!;
        const memberPath = [...path, member];
        const memberName = [field, ...memberPath].join(".");
        if ("flatten" in projected) {
          if (positional)
            throw new Error(
              `${contract.name}.${memberName} is a positional object`,
            );
          return memberParameters(
            field,
            memberPath,
            memberDeclared,
            projected.flatten,
            required,
          );
        }
        const memberRequired = required && !admitsOmission(memberDeclared);
        if (positional && !memberRequired)
          throw new Error(
            `${contract.name}.${memberName} is an optional positional`,
          );
        const omittable = (schema: z.ZodType) =>
          memberRequired ? schema : schema.optional();
        const callerPath = projected.callerPath === true;
        let schema: z.ZodType;
        if (callerPath) {
          if (!(core(memberDeclared) instanceof z.ZodString))
            throw new Error(`${contract.name}.${memberName} is not a path`);
          schema = omittable(localPathStringSchema);
        } else {
          assertArgvField(contract.name, memberName, memberDeclared);
          // An omitted member stays omitted; the contract applies its default.
          schema = argvDecimal(omittable(withoutDefault(memberDeclared)));
        }
        const description =
          projected.description ?? describedThroughWrappers(memberDeclared);
        if (description !== undefined) schema = schema.describe(description);
        const value = core(memberDeclared);
        return [
          {
            field,
            key: projected.name ?? camelCase(member),
            positional,
            alias: projected.alias,
            description,
            schema,
            inbound: false,
            booleanFlag: value instanceof z.ZodBoolean,
            cliDefault: undefined,
            repeatable: value instanceof z.ZodArray,
            decimal: isNumericCore(value),
            callerPath,
            delivery: false,
            jsonText: false,
            viewSelection: false,
            runtimeJson: undefined,
            jsonInput: false,
            checkJsonInput: undefined,
            nullFlag: undefined,
            member: memberPath,
            selectorOption: undefined,
            group: undefined,
          },
        ];
      },
    );
    // Argv supplies an object only through its given members, so a required
    // object needs a required member; otherwise omitting them all drops it.
    if (
      required &&
      memberParameterList.every(
        ({ schema }) => schema.safeParse(undefined).success,
      )
    )
      throw new Error(`${contract.name}.${name} has no required member`);
    return memberParameterList;
  };
  const parameters: ContractCliParameter[] = [
    ...positionals,
    ...Object.keys(shape).filter(
      (field) =>
        !positionals.includes(field) &&
        !Object.hasOwn(omitted, field) &&
        !targetFields.has(field) &&
        !handlerFields.includes(field) &&
        !fixedFields.has(field) &&
        !groupedFields.has(field),
    ),
  ].flatMap((field) =>
    flattened[field] === undefined
      ? [parameter(field)]
      : memberParameters(field, [], shape[field]!, flattened[field], true),
  );
  for (const [key, group] of Object.entries(fieldGroups))
    if (group !== undefined)
      parameters.push({
        field: key,
        key,
        positional: false,
        alias: undefined,
        description: group.description,
        schema: z.string().optional().describe(group.description),
        inbound: false,
        booleanFlag: false,
        cliDefault: undefined,
        repeatable: false,
        decimal: false,
        callerPath: false,
        delivery: false,
        jsonText: false,
        viewSelection: false,
        runtimeJson: group.invalidJson,
        jsonInput: false,
        checkJsonInput: undefined,
        nullFlag: undefined,
        member: undefined,
        selectorOption: undefined,
        group: group.fields,
      });
  const cliOptions: CliOptionShape = projection.cliOptions ?? {};
  const cliPositionalKeys: readonly string[] = projection.cliPositionals ?? [];
  for (const key of cliPositionalKeys)
    if (!Object.hasOwn(cliOptions, key))
      throw new Error(`${contract.name} has no CLI option ${key}`);
  const cliPositionals: readonly CliOnlyOption[] = cliPositionalKeys.map(
    (key) => ({
      key,
      description: cliOptions[key]!.description,
      schema: cliOptions[key]!,
    }),
  );
  const cliOnlyOptions: readonly CliOnlyOption[] = [
    ...Object.values(nullFlags).flatMap((flag) =>
      flag === undefined
        ? []
        : [
            [
              flag.key,
              z.boolean().default(false).describe(flag.description),
            ] satisfies [string, z.ZodType],
          ],
    ),
    ...Object.entries(
      evidenceDelivery
        ? Object.hasOwn(shape, "detail")
          ? { evidence_output: analysisEvidenceDeliveryOptions.evidence_output }
          : analysisEvidenceDeliveryOptions
        : {},
    ),
    ...Object.entries(cliOptions).filter(
      ([key]) => !cliPositionalKeys.includes(key),
    ),
  ].map(([key, schema]: [string, z.ZodType]) => ({
    key,
    description: schema.description,
    schema,
  }));
  const sessionTarget = describeSessionTarget(projection.sessionTarget);
  const evidenceTargets = describeEvidenceTargets(
    contract,
    shape,
    projection.evidenceTargets,
  );
  // Keys the command adds beside the contract parameters.
  const sessionTargetKeys = [
    ...(sessionTarget === undefined
      ? []
      : [sessionTarget.key, ...sessionTarget.options.map(({ key }) => key)]),
    ...(evidenceTargets === undefined
      ? []
      : [
          ...evidenceTargets.targets.map(({ key }) => key),
          ...evidenceTargets.options.map(({ key }) => key),
        ]),
  ];
  const selectorKeys = parameters.flatMap(({ selectorOption }) =>
    selectorOption === undefined
      ? []
      : [
          selectorOption.key,
          ...(selectorOption.alternative === undefined
            ? []
            : [selectorOption.alternative.key]),
        ],
  );
  // A selector option may share its positional's key: argv keeps them apart.
  const keys = new Set([
    ...sessionTargetKeys,
    ...parameters.map(({ key }) => key),
    ...cliOnlyOptions.map(({ key }) => key),
    ...cliPositionalKeys,
  ]);
  const optionKeys = new Set([
    ...sessionTargetKeys,
    ...parameters.flatMap(({ key, positional }) => (positional ? [] : [key])),
    ...cliOnlyOptions.map(({ key }) => key),
    ...selectorKeys,
  ]);
  if (
    keys.size !==
      sessionTargetKeys.length +
        parameters.length +
        cliOnlyOptions.length +
        cliPositionalKeys.length ||
    optionKeys.size !==
      sessionTargetKeys.length +
        parameters.filter(({ positional }) => !positional).length +
        cliOnlyOptions.length +
        selectorKeys.length
  )
    throw new Error(`${contract.name} projects two fields to one CLI key`);
  const cliOptionDependencies = Object.fromEntries(
    Object.entries(projection.cliOptionDependencies ?? {}).filter(
      (entry): entry is [string, readonly string[]] => entry[1] !== undefined,
    ),
  );
  for (const [key, required] of Object.entries(cliOptionDependencies))
    for (const dependency of [key, ...required])
      if (!keys.has(dependency))
        throw new Error(`${contract.name} has no CLI option ${dependency}`);
  const keyOf = new Map(
    parameters.flatMap(({ field, key, member }) =>
      member === undefined ? [[field, key] as const] : [],
    ),
  );
  const rename = (field: string): string => keyOf.get(field) ?? field;

  const toContractInput = (
    values: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> => {
    const input: Record<string, unknown> = Object.fromEntries(fixedFields);
    for (const {
      field,
      key,
      callerPath,
      delivery,
      member,
      selectorOption,
      group,
    } of parameters) {
      // The named spelling is preserved when both agree.
      const value =
        (selectorOption === undefined
          ? undefined
          : values[selectorOption.valueKey]) ?? values[key];
      if (value === undefined || delivery || member !== undefined) continue;
      if (group !== undefined) {
        // A decoded group supplies each member it names as that field.
        if (isRecord(value))
          for (const grouped of group)
            if (Object.hasOwn(value, grouped)) input[grouped] = value[grouped];
        continue;
      }
      input[field] = !callerPath
        ? value
        : Array.isArray(value)
          ? value.map((path: string) => absoluteCallerPath(path))
          : absoluteCallerPath(value as string);
    }
    // Any member given supplies each enclosing object, so the contract names
    // a missing companion; an omitted member stays omitted, not undefined.
    for (const { field, key, member, callerPath } of parameters) {
      const value = values[key];
      if (member === undefined || value === undefined) continue;
      let object = (input[field] ??= {}) as Record<string, unknown>;
      for (const enclosing of member.slice(0, -1))
        object = (object[enclosing] ??= {}) as Record<string, unknown>;
      object[member.at(-1)!] = callerPath
        ? absoluteCallerPath(value as string)
        : value;
    }
    for (const { field, nullFlag } of parameters)
      if (nullFlag !== undefined && values[nullFlag] === true)
        input[field] = null;
    return input;
  };
  const nullFlagLimits = parameters.flatMap(({ key, nullFlag }) =>
    nullFlag === undefined ? [] : [[nullFlag, key] as const],
  );

  // Cross-field rules belong to the contract: run its own object checks on
  // the options mapped to contract names, then name CLI keys. Positional
  // values are not visible here; the service's contract parse still
  // enforces every rule.
  const checks =
    projection.crossFieldRules === "argv"
      ? (contract.inputSchema._zod.def.checks ?? [])
      : [];
  if (
    checks.length > 0 &&
    parameters.some(({ runtimeJson }) => runtimeJson !== undefined)
  )
    throw new Error(
      `${contract.name} decodes JSON when it runs, after argv cross-field rules`,
    );
  const contractChecks = z
    .object({})
    .loose()
    .check(...(checks as z.core.$ZodCheck<Record<string, unknown>>[]));
  const checkOptions =
    checks.length === 0 && nullFlagLimits.length === 0
      ? undefined
      : (options: Readonly<Record<string, unknown>>) => {
          const conflicts = nullFlagLimits.flatMap(([flag, limit]) => {
            if (options[flag] !== true || options[limit] === undefined)
              return [];
            const message = `${flag} and ${limit} are mutually exclusive`;
            const issue: z.core.$ZodIssueCustom = {
              code: "custom",
              path: [flag],
              message,
              input: undefined,
            };
            return [{ path: [flag], message, issue }];
          });
          // Checks observe execution defaults, while the command retains the
          // caller's raw selections. Resolve only omitted fields: supplied
          // options have already passed argv admission, and JSON text is not
          // decoded until the command runs.
          const checkInput = toContractInput(options);
          if (checks.length > 0)
            for (const [field, declared] of Object.entries(shape)) {
              if (Object.hasOwn(checkInput, field)) continue;
              const omitted = declared.safeParse(undefined);
              if (omitted.success && omitted.data !== undefined)
                checkInput[field] = omitted.data;
            }
          const result = contractChecks.safeParse(checkInput);
          return result.success
            ? conflicts
            : [
                ...conflicts,
                ...result.error.issues.map((issue) => {
                  const [field, ...rest] = issue.path;
                  return {
                    path:
                      typeof field === "string"
                        ? [rename(field), ...rest]
                        : issue.path,
                    message: issue.message,
                    issue,
                  };
                }),
              ];
        };

  return {
    command: projectedCommand(contract, projection.command),
    description: projection.description,
    contract,
    parameters,
    cliOnlyOptions,
    cliPositionals,
    omitted,
    handlerFields,
    fixedFields: Object.fromEntries(fixedFields),
    fields: shape,
    optionConstraints: projectObjectConstraints(
      contract,
      // A grouped field is a JSON member, not an option, so an object rule
      // naming it has no CLI projection.
      (field) => {
        if (groupedFields.has(field))
          throw new Error(
            `${contract.name}.${field} is grouped but named by an input rule`,
          );
        return rename(field);
      },
      new Set([...unprojectedFields, ...selectors]),
      cliOptionDependencies,
      nullFlagLimits,
    ),
    checkOptions,
    toContractInput,
    callerInputs: (values) =>
      Object.fromEntries(
        parameters.flatMap(({ field, key, callerPath, member }) => {
          const value = values[key];
          return callerPath && value !== undefined
            ? [
                [
                  [field, ...(member ?? [])].join("."),
                  value as string | readonly string[],
                ],
              ]
            : [];
        }),
      ),
    cliOptionValues: (values) =>
      Object.fromEntries(
        Object.keys(cliOptions).flatMap((key) =>
          values[key] === undefined ? [] : [[key, values[key]]],
        ),
      ),
    sessionTarget,
    evidenceTargets,
    inputBinding: {
      operation: contract.name,
      fields: Object.fromEntries(
        [
          // A selector field is named by its own option: its positional may
          // share another key, and selection issues already use the option.
          ...parameters.flatMap(({ field, key, member, selectorOption }) =>
            member === undefined
              ? [{ field, key: selectorOption?.key ?? key }]
              : [],
          ),
          ...(evidenceTargets?.targets ?? []),
        ].flatMap(({ field, key }) => (key === field ? [] : [[field, key]])),
      ),
      flags: Object.fromEntries(
        parameters.flatMap(
          ({
            field,
            key,
            member,
            positional,
            delivery,
            group,
            selectorOption,
          }) => {
            if (delivery) return [];
            // A positional selector is also set by its named option.
            if (positional)
              return selectorOption === undefined
                ? []
                : [[field, `--${optionFlagName(selectorOption.key)}`] as const];
            const flag = `--${optionFlagName(key)}`;
            // A field group's option supplies each of its contract fields.
            if (group !== undefined)
              return group.map((grouped) => [grouped, flag] as const);
            return [
              [
                member === undefined ? field : [field, ...member].join("."),
                flag,
              ] as const,
            ];
          },
        ),
      ),
    },
    evidenceDelivery,
    admit: (values) => {
      const selectedValues: Record<string, unknown> = { ...values };
      for (const { key, selectorOption } of parameters) {
        if (selectorOption === undefined) continue;
        const selected = selectSpelledSelector(
          contract.name,
          selectorOption,
          values[key] as string | undefined,
          values,
        );
        if (!selected.ok) return selected;
        selectedValues[selectorOption.valueKey] = selected.value;
      }
      return admitInvocation(
        contract,
        {
          evidenceDelivery,
          viewDelivery,
          parameters,
          shape,
          wholeInput:
            sessionTarget === undefined &&
            evidenceTargets === undefined &&
            handlerFields.length === 0,
          checkedFields: Object.keys(jsonInputChecks),
        },
        selectedValues,
        toContractInput,
        rename,
      );
    },
    admitDeliveryOptions: (values) => {
      const decoded = decodeInlineJson(contract.name, parameters, values);
      if (!decoded.ok) return decoded;
      if (!evidenceDelivery) return decoded;
      const view =
        viewDelivery === undefined
          ? undefined
          : (decoded.value[rename("view")] as AnalysisViewRequest | undefined);
      // The view's own refusal comes first, as in full admission, where the
      // contract admits the view before the delivery rules apply.
      if (view !== undefined) {
        const checked = shape.view!.safeParse(view);
        if (!checked.success)
          return err(
            analysisInputErrorFromIssues(
              contract.name,
              checked.error.issues.map((issue) => ({
                ...issue,
                path: ["view", ...issue.path],
              })),
              { view },
            ),
          );
      }
      const detail = decoded.value[rename("detail")] as
        | "complete"
        | "summary"
        | undefined;
      const refused = cliEvidenceDeliveryInputError({
        operation: contract.name,
        detail: detail ?? (view === undefined ? "complete" : "summary"),
        evidenceOutput: decoded.value.evidence_output as string | undefined,
        view,
      });
      return refused === undefined ? decoded : err(refused);
    },
  };
};

/**
 * Decode each inline run-time JSON option. JSON inputs, which may name a
 * file, are read and decoded by the command before admission.
 */
const decodeInlineJson = (
  operation: string,
  parameters: readonly ContractCliParameter[],
  values: Readonly<Record<string, unknown>>,
): Result<Record<string, unknown>, AnalysisInputError> => {
  const decoded: Record<string, unknown> = { ...values };
  for (const { key, runtimeJson, jsonInput, group } of parameters) {
    if (runtimeJson === undefined || jsonInput) continue;
    const parsed = parseCliJsonOption(
      operation,
      key,
      values[key] as string | undefined,
      runtimeJson,
    );
    if (!parsed.ok) return parsed;
    if (group !== undefined && parsed.value !== undefined) {
      const members = admitGroupMembers(
        operation,
        key,
        group,
        runtimeJson,
        parsed.value,
      );
      if (!members.ok) return members;
    }
    decoded[key] = parsed.value;
  }
  return ok(decoded);
};

/** A group is a JSON object whose members are its own fields. */
const admitGroupMembers = (
  operation: string,
  key: string,
  group: readonly string[],
  invalidJson: string,
  value: unknown,
): Result<void, AnalysisInputError> => {
  if (!isRecord(value))
    return err(
      new AnalysisInputError(operation, undefined, [
        {
          path: [key],
          reason: "invalid_format",
          expected: "JSON",
          message: invalidJson,
        },
      ]),
    );
  const members = z.strictObject(
    Object.fromEntries(group.map((field) => [field, z.unknown().optional()])),
  );
  const admitted = members.safeParse(value);
  return admitted.success
    ? ok(undefined)
    : err(
        analysisInputErrorFromIssues(
          operation,
          admitted.error.issues.map((issue) => ({
            ...issue,
            path: [key, ...issue.path],
          })),
          { [key]: value },
        ),
      );
};

/**
 * Select one selector from its positional, its named option and any
 * alternative option. The named option and the alternative agree only as
 * text; the positional then agrees with either as the selector's kind, and
 * a conflict names the option the caller used.
 */
const selectSpelledSelector = (
  operation: string,
  selector: ContractCliSelectorOption,
  positional: string | undefined,
  values: Readonly<Record<string, unknown>>,
): Result<string | undefined, AnalysisInputError> => {
  const { alternative } = selector;
  let named = values[selector.valueKey] as string | undefined;
  let option = selector.key;
  const otherSpelling =
    alternative === undefined
      ? undefined
      : (values[alternative.valueKey] as string | undefined);
  if (alternative !== undefined && otherSpelling !== undefined) {
    const merged = selectCliAnalysisSelector(
      named,
      alternative.selects(otherSpelling),
      { option: alternative.key, operation, kind: "text", required: false },
    );
    if (!merged.ok) return merged;
    named = merged.value;
    option = alternative.key;
  }
  const selected = selectCliAnalysisSelector(positional, named, {
    option,
    operation,
    kind: selector.kind,
    required: selector.required,
  });
  // The named spelling is preserved when both agree.
  return selected.ok ? ok(named ?? positional) : selected;
};

/**
 * Map decoded values to the contract input and selected delivery.
 * When the projection decodes JSON at run time, the
 * decoded input, delivery and view are admitted together by the contract
 * input schema, so the contract's own rules and messages apply. When argv
 * supplies the whole contract input, it is parsed once the same way and the
 * handler receives the parse or the refusal.
 */
const admitInvocation = (
  contract: ProjectedContract,
  command: {
    readonly evidenceDelivery: boolean;
    readonly viewDelivery: CliViewDelivery | undefined;
    readonly parameters: readonly ContractCliParameter[];
    readonly shape: Readonly<Record<string, z.ZodType>>;
    /**
     * Argv supplies every contract field: no session target, Evidence
     * target or handler fills one.
     */
    readonly wholeInput: boolean;
    /**
     * `jsonInputChecks` fields. Their checks already admitted the decoded
     * documents, so the whole-input parse does not walk and copy them again.
     */
    readonly checkedFields: readonly string[];
  },
  values: Readonly<Record<string, unknown>>,
  toContractInput: ContractCliDescription["toContractInput"],
  rename: (field: string) => string,
): Result<ContractCliAdmission, AnalysisInputError> => {
  const {
    evidenceDelivery,
    viewDelivery,
    parameters,
    shape,
    wholeInput,
    checkedFields,
  } = command;
  const decoded = values;
  const input = toContractInput(decoded);
  const detail = evidenceDelivery
    ? (decoded[rename("detail")] as "complete" | "summary" | undefined)
    : undefined;
  let view: object | undefined;
  let parsed: unknown;
  let parseWholeInput: ContractCliAdmission["parseWholeInput"];
  const runtimeJson = parameters.some(
    ({ runtimeJson }) => runtimeJson !== undefined,
  );
  const selected =
    viewDelivery === undefined ? undefined : decoded[rename("view")];
  const candidate = {
    ...input,
    ...(detail === undefined || !Object.hasOwn(shape, "detail")
      ? {}
      : { detail }),
    ...(selected === undefined ? {} : { view: selected }),
  };
  const schema = contract.inputSchema;
  const unchecked =
    checkedFields.length > 0 && schema instanceof z.ZodObject
      ? schema.omit(
          Object.fromEntries(
            checkedFields.map((field) => [field, true]),
          ) as Record<string, true> & Record<number, never>,
        )
      : undefined;
  const parseCandidate = (): Result<unknown, AnalysisInputError> => {
    if (unchecked !== undefined) {
      const rest: Record<string, unknown> = { ...candidate };
      const documents: Record<string, unknown> = {};
      for (const field of checkedFields)
        if (Object.hasOwn(rest, field)) {
          documents[field] = rest[field];
          delete rest[field];
        }
      const admitted = unchecked.safeParse(rest);
      return admitted.success
        ? ok({ ...admitted.data, ...documents })
        : err(
            analysisInputErrorFromIssues(
              contract.name,
              admitted.error.issues,
              candidate,
            ),
          );
    }
    const admitted = schema.safeParse(candidate);
    return admitted.success
      ? ok(admitted.data)
      : err(
          analysisInputErrorFromIssues(
            contract.name,
            admitted.error.issues,
            candidate,
          ),
        );
  };
  if (runtimeJson || (wholeInput && viewDelivery !== undefined)) {
    // The delivery needs the admitted view, and run-time JSON is refused
    // here, so these parse now.
    const admitted = parseCandidate();
    if (admitted.ok) {
      parsed = admitted.value;
      if (viewDelivery !== undefined)
        ({ view } = admitted.value as { readonly view?: object });
    } else if (runtimeJson) return admitted;
    else parseWholeInput = () => admitted;
  } else if (wholeInput) {
    // Only a handler that reads the parse pays for it, once.
    let memo: Result<unknown, AnalysisInputError> | undefined;
    parseWholeInput = () => (memo ??= parseCandidate());
  }
  if (!evidenceDelivery)
    return ok({ input, parsed, parseWholeInput, delivery: undefined });
  const delivery: CliEvidenceDeliveryChoice = {
    detail: detail ?? (view === undefined ? "complete" : "summary"),
    evidenceOutput: decoded.evidence_output as string | undefined,
    ...(view === undefined
      ? {}
      : {
          view: (viewDelivery?.kind === undefined
            ? view
            : { kind: viewDelivery.kind, ...view }) as AnalysisViewRequest,
        }),
  };
  const refused = cliEvidenceDeliveryInputError({
    ...delivery,
    operation: contract.name,
  });
  return refused === undefined
    ? ok({ input, parsed, parseWholeInput, delivery })
    : err(refused);
};

/**
 * Describe each contract an operation option selects. Each must project to
 * the registered command's exact arguments, options and object-level option
 * rules, so the help and schema the registered contract advertises hold for
 * every choice.
 */
export const describeOperationChoices = (
  description: ContractCliDescription,
  projection: CliContractProjection<string, CliOptionShape>,
): ReadonlyMap<unknown, ContractCliDescription> => {
  const choices = new Map<unknown, ContractCliDescription>();
  const signature = (described: ContractCliDescription): string =>
    JSON.stringify([
      described.parameters.map(({ key, positional, schema }) => [
        key,
        positional,
        z.toJSONSchema(schema, { unrepresentable: "any" }),
      ]),
      described.optionConstraints ?? null,
    ]);
  const expected = signature(description);
  for (const [value, contract] of Object.entries(
    projection.operationBy?.contracts ?? {},
  )) {
    const described = describeContractCommand(contract, projection);
    if (signature(described) !== expected)
      throw new Error(
        `${contract.name} does not project to ${description.command}'s options`,
      );
    choices.set(value, described);
  }
  return choices;
};
