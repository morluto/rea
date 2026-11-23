import type { z } from "zod";

import { cliCommandFor } from "../contracts/cliCommandNames.js";
import type { ContractCliDocumentDescription } from "./contractCliDescription.js";
import type { ContractCliDescription } from "./contractCliDescriptionTypes.js";
import type { CliInstance } from "./types.js";
import { optionFlagName } from "./optionFields.js";

/** One contract operation a command can run, with the flag of each field it takes. */
export interface CliCommandOperation {
  /** The contract name, which is the MCP operation. */
  readonly name: string;
  /**
   * The flag that sets each contract field, or `field.member`, on this
   * command, such as `{ entry_point: "--entry-point" }`. Positionals and
   * delivery fields have no flag.
   */
  readonly flags: Readonly<Record<string, string>>;
  /**
   * The CLI selector option and value that chooses this operation when the
   * command defaults to another contract, such as `"--kind procedures"`.
   */
  readonly selector?: string | undefined;
}

type Inputs<Schema extends z.ZodObject | undefined> = Schema extends z.ZodObject
  ? z.output<Schema>
  : Record<never, never>;

/** What a command's handler receives. */
export interface CliCommandRunContext<
  Args extends z.ZodObject | undefined,
  Options extends z.ZodObject | undefined,
> {
  readonly args: Inputs<Args>;
  readonly options: Inputs<Options>;
  /** The caller chose an output format (`--format` or `--json`). */
  readonly formatExplicit: boolean;
}

/** A command as its registrar defines it. */
export interface CliCommandDefinition<
  Args extends z.ZodObject | undefined = undefined,
  Options extends z.ZodObject | undefined = undefined,
> {
  readonly description?: string | undefined;
  /** Positionals, in argv order. */
  readonly args?: Args;
  readonly options?: Options;
  /** Short alias by option key, such as `{ yes: "y" }`. */
  readonly alias?: Readonly<Record<string, string>> | undefined;
  /** `agent-only` hides the result on a terminal unless a format is chosen. */
  readonly outputPolicy?: "all" | "agent-only" | undefined;
  readonly run: (context: CliCommandRunContext<Args, Options>) => unknown;
}

/** How a command was described, for readers that need the full projection. */
export type CliCommandSource =
  | { readonly kind: "contract"; readonly description: ContractCliDescription }
  | {
      readonly kind: "routed";
      readonly descriptions: readonly ContractCliDescription[];
    }
  | {
      readonly kind: "document";
      readonly description: ContractCliDocumentDescription;
    }
  | { readonly kind: "host" };

/** One registered command. */
export interface CliCommandEntry {
  readonly name: string;
  /**
   * The definition the dispatcher runs. Shell owners may still replace its
   * input schemas in place before serving (omittable defaults), so readers
   * see what is served.
   */
  readonly definition: CliCommandDefinition<
    z.ZodObject | undefined,
    z.ZodObject | undefined
  >;
  /** Contract operations the command runs, in the order it chooses them. */
  readonly operations: readonly CliCommandOperation[];
  readonly source: CliCommandSource;
}

interface CliRegistry {
  readonly entries: CliCommandEntry[];
  readonly byName: Map<string, CliCommandEntry>;
}

const registries = new WeakMap<CliInstance, CliRegistry>();

/**
 * Register one command: record it in REA's command table, in registration
 * order. The dispatcher reads this table; every command is registered here.
 */
export const registerCliCommand = <
  const Args extends z.ZodObject | undefined = undefined,
  const Options extends z.ZodObject | undefined = undefined,
>(
  cli: CliInstance,
  name: string,
  definition: CliCommandDefinition<Args, Options>,
  registration: {
    readonly operations?: readonly CliCommandOperation[];
    readonly source?: CliCommandSource;
  } = {},
): void => {
  let registry = registries.get(cli);
  if (registry === undefined) {
    registry = { entries: [], byName: new Map() };
    registries.set(cli, registry);
  }
  if (registry.byName.has(name))
    throw new Error(`CLI command ${name} is registered twice`);
  const entry: CliCommandEntry = {
    name,
    definition: definition as CliCommandEntry["definition"],
    operations: registration.operations ?? [],
    source: registration.source ?? { kind: "host" },
  };
  registry.entries.push(entry);
  operationCommandIndexes.delete(registry.entries);
  registry.byName.set(name, entry);
};

/** Commands registered on this CLI, in registration order. */
export const cliCommands = (cli: CliInstance): readonly CliCommandEntry[] =>
  registries.get(cli)?.entries ?? [];

/** Resolve a command identity from the same records the dispatcher serves. */
export const cliCommand = (
  cli: CliInstance,
  name: string,
): CliCommandEntry | undefined => registries.get(cli)?.byName.get(name);

/**
 * The operations one contract description runs: its own contract, the
 * contract that opens its session target, and the source of its Evidence
 * targets, each with the flags this command gives its fields.
 */
export const contractDescriptionOperations = (
  description: Pick<ContractCliDescription, "sessionTarget"> & {
    readonly inputBinding?: ContractCliDescription["inputBinding"];
    readonly contract: { readonly name: string };
    readonly evidenceTargets?: ContractCliDescription["evidenceTargets"];
  },
  options: { readonly selector?: string | undefined } = {},
): readonly CliCommandOperation[] => {
  const { sessionTarget, evidenceTargets } = description;
  return [
    {
      name: description.contract.name,
      flags: description.inputBinding?.flags ?? {},
      ...(options.selector === undefined ? {} : { selector: options.selector }),
    },
    ...(sessionTarget?.opening === undefined
      ? []
      : [
          {
            name: sessionTarget.opening,
            flags: Object.fromEntries(
              sessionTarget.options.map(({ field, key }) => [
                field,
                `--${optionFlagName(key)}`,
              ]),
            ),
          },
        ]),
    ...(evidenceTargets === undefined
      ? []
      : [{ name: evidenceTargets.source, flags: evidenceTargets.sourceFlags }]),
  ];
};

/** Merge operation lists, keeping the first entry of each operation. */
export const distinctOperations = (
  operations: readonly CliCommandOperation[],
): readonly CliCommandOperation[] => {
  const seen = new Set<string>();
  return operations.filter(({ name }) => !seen.has(name) && seen.add(name));
};

/**
 * Contract operations the command itself answers, excluding the session-target
 * opener and any Evidence-target source operation it runs first.
 */
export const commandOwnOperations = (
  entry: CliCommandEntry,
): readonly CliCommandOperation[] => {
  const { source, operations } = entry;
  if (source.kind === "contract") {
    const opening = source.description.sessionTarget?.opening;
    const targetSource = source.description.evidenceTargets?.source;
    return operations.filter(
      ({ name }) => name !== opening && name !== targetSource,
    );
  }
  if (source.kind === "routed") {
    const own = new Set<string>(
      source.descriptions.map((description) => description.contract.name),
    );
    return operations.filter(({ name }) => own.has(name));
  }
  if (source.kind === "document") {
    const opening = source.description.sessionTarget?.opening;
    return operations.filter(({ name }) => name !== opening);
  }
  return operations;
};

interface OperationCommandIndex {
  readonly canonical: ReadonlyMap<string, string>;
  readonly contractPrimary: ReadonlyMap<string, string>;
  readonly contractSecondary: ReadonlyMap<string, string>;
  readonly otherMatch: ReadonlyMap<string, string>;
}

const operationCommandIndexes = new WeakMap<
  readonly CliCommandEntry[],
  OperationCommandIndex
>();

const getOperationCommandIndex = (
  entries: readonly CliCommandEntry[],
): OperationCommandIndex => {
  let cached = operationCommandIndexes.get(entries);
  if (cached !== undefined) return cached;
  const canonical = new Map<string, string>();
  const contractPrimary = new Map<string, string>();
  const contractSecondary = new Map<string, string>();
  const otherMatch = new Map<string, string>();
  for (const entry of entries) {
    const own = commandOwnOperations(entry);
    const primaryName = own[0]?.name;
    for (let index = 0; index < own.length; index += 1) {
      const matched = own[index]!;
      const opName = matched.name;
      const command =
        matched.selector === undefined
          ? entry.name
          : `${entry.name} ${matched.selector}`;
      if (entry.name === cliCommandFor(opName) && !canonical.has(opName))
        canonical.set(opName, command);
      if (entry.source.kind === "contract") {
        if (primaryName === opName) {
          if (!contractPrimary.has(opName))
            contractPrimary.set(opName, command);
        } else if (!contractSecondary.has(opName)) {
          contractSecondary.set(opName, command);
        }
      } else if (!otherMatch.has(opName)) {
        otherMatch.set(opName, command);
      }
    }
  }
  cached = { canonical, contractPrimary, contractSecondary, otherMatch };
  operationCommandIndexes.set(entries, cached);
  return cached;
};

/**
 * The CLI command spelling (`rea <command>`) that runs a contract operation,
 * or undefined when no CLI command answers it. Prefers the canonical
 * single-contract command, then a contract command whose own operations start
 * with or include it, then any other registered command whose own operations
 * include it.
 */
export const cliCommandForOperation = (
  operation: string,
  entries: readonly CliCommandEntry[],
  cliName: string,
  recordedCommands?: Readonly<Record<string, string>>,
): string | undefined => {
  const index = getOperationCommandIndex(entries);
  const direct = index.canonical.get(operation);
  if (direct !== undefined) return `${cliName} ${direct}`;
  const canonical = cliCommandFor(operation);
  if (
    recordedCommands !== undefined &&
    Object.hasOwn(recordedCommands, canonical)
  )
    return `${cliName} ${canonical}`;
  const selected =
    index.contractPrimary.get(operation) ??
    index.contractSecondary.get(operation) ??
    index.otherMatch.get(operation);
  return selected === undefined ? undefined : `${cliName} ${selected}`;
};
