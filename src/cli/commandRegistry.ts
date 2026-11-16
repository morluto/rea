import type { z } from "zod";

import type {
  ContractCliDescription,
  ContractCliDocumentDescription,
} from "./contractCliDescription.js";
import type { CliInstance } from "./types.js";

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
   * inputs and handler in place before serving (omittable defaults, result
   * output, argument policy), so readers see what is served.
   */
  readonly definition: CliCommandDefinition<
    z.ZodObject | undefined,
    z.ZodObject | undefined
  >;
  /** Contract operations the command runs, in the order it chooses them. */
  readonly operations: readonly CliCommandOperation[];
  readonly source: CliCommandSource;
}

const registries = new WeakMap<CliInstance, CliCommandEntry[]>();

/**
 * Register one command: record it in REA's command table, in registration
 * order, and hand it to the dispatcher. Every command is registered here.
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
  const entries = registries.get(cli) ?? [];
  if (entries.some((entry) => entry.name === name))
    throw new Error(`CLI command ${name} is registered twice`);
  // The dispatcher keeps this object, so in-place changes reach both.
  (cli.command as (name: string, definition: object) => unknown)(
    name,
    definition,
  );
  entries.push({
    name,
    definition: definition as CliCommandEntry["definition"],
    operations: registration.operations ?? [],
    source: registration.source ?? { kind: "host" },
  });
  registries.set(cli, entries);
};

/** Commands registered on this CLI, in registration order. */
export const cliCommands = (cli: CliInstance): readonly CliCommandEntry[] =>
  registries.get(cli) ?? [];

const kebabCase = (key: string): string =>
  key.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

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
): readonly CliCommandOperation[] => {
  const { sessionTarget, evidenceTargets } = description;
  return [
    {
      name: description.contract.name,
      flags: description.inputBinding?.flags ?? {},
    },
    ...(sessionTarget?.opening === undefined
      ? []
      : [
          {
            name: sessionTarget.opening,
            flags: Object.fromEntries(
              sessionTarget.options.map(({ field, key }) => [
                field,
                `--${kebabCase(key)}`,
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
