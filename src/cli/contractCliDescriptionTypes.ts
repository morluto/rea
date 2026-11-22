import type { z } from "zod";

import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { AnalysisInputError } from "../domain/analysisErrorCore.js";
import type { AnalysisViewRequest } from "../domain/analysisView/analysisViewRequest.js";
import type { CallerInputPaths } from "../domain/evidence.js";
import type { Result } from "../domain/result.js";
import type { CliSelectorKind } from "./analysisSelector.js";

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
