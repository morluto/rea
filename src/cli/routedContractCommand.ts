import { z } from "zod";
import type { Logger } from "pino";

import { logCliCommand } from "../cliLogging.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { describeContractCommand } from "./contractCliDescription.js";
import { withoutDefault } from "./contractCliSchemaProjection.js";
import type {
  CliContractProjection,
  CliOptionShape,
  CliOptionValues,
  ContractCliDescription,
  ContractField,
  ProjectedContract,
} from "./contractCliDescriptionTypes.js";
import { projectCliInputFields } from "./projectCliAnalysisResult.js";
import {
  contractDescriptionOperations,
  distinctOperations,
  registerCliCommand,
} from "./commandRegistry.js";
import type { CliInstance } from "./types.js";
import { optionFlagName } from "./optionFields.js";
import {
  admitOpening,
  commandOptions,
  commandPositionals,
  jsonInputKeys,
  projectCliResult,
  readJsonInputs,
  type ContractCommandContext,
} from "./contractCommand.js";

/** One contract input a routed command runs, with the inputs it takes. */
export interface CliCommandRoute {
  readonly description: ContractCliDescription;
  /**
   * Whether this route takes the given input. Only a route that owns every
   * option the caller gave is asked; the last route takes every other input.
   */
  readonly takes: ((values: RouteValues) => Promise<boolean>) | undefined;
  /**
   * What this route's input is, named when an option the caller gave belongs
   * to another route.
   */
  readonly requirement: string;
  readonly run: (
    input: unknown,
    context: ContractCommandContext,
  ) => Promise<unknown>;
}

/**
 * The parsed arguments and options of a routed command, keyed by CLI key.
 * JSON inputs that every route takes are already decoded, so a route can be
 * chosen by document content.
 */
export type RouteValues = Readonly<Record<string, unknown>>;

/** Describe one route of a routed command from its contract input. */
export const commandRoute = <
  Contract extends ProjectedContract,
  CliOptions extends CliOptionShape = Record<never, z.ZodType>,
>(
  contract: Contract,
  projection: CliContractProjection<ContractField<Contract>, CliOptions>,
  run: (
    input: z.input<Contract["inputSchema"]>,
    context: ContractCommandContext<
      CliOptionValues<CliOptions>,
      z.output<Contract["inputSchema"]>
    >,
  ) => Promise<unknown>,
  route: {
    readonly takes?: (values: RouteValues) => Promise<boolean>;
    readonly requirement: string;
  },
): CliCommandRoute => {
  if (projection.operationBy !== undefined)
    throw new Error(`${contract.name} routes by target and by an option`);
  return {
    description: describeContractCommand(contract, projection),
    takes: route.takes,
    requirement: route.requirement,
    run: run as CliCommandRoute["run"],
  };
};

/**
 * The input shape of a union contract that has `field`, as a contract a
 * route can project: the same operation, admitted by that shape alone.
 */
export const contractInputBranch = <
  Name extends string,
  Branches extends readonly z.ZodObject[],
  Field extends string,
>(
  contract: {
    readonly name: Name;
    readonly cli?: true;
    readonly inputSchema: z.ZodUnion<Branches>;
  },
  field: Field,
): {
  readonly name: Name;
  readonly cli?: true;
  readonly inputSchema: Extract<
    Branches[number],
    { readonly shape: { readonly [Key in Field]: z.ZodType } }
  >;
} => {
  const branches = contract.inputSchema.options.filter((branch) =>
    Object.hasOwn(branch.shape, field),
  );
  if (branches.length !== 1)
    throw new Error(`${contract.name} has no single input shape with ${field}`);
  return {
    name: contract.name,
    ...(contract.cli === undefined ? {} : { cli: contract.cli }),
    inputSchema: branches[0] as Extract<
      Branches[number],
      { readonly shape: { readonly [Key in Field]: z.ZodType } }
    >,
  };
};

/** The argv arguments and options one description takes, keyed by CLI key. */
const commandShape = (description: ContractCliDescription) => ({
  args: commandPositionals(description).map(
    ({ key, schema }) => [key, schema] as const,
  ),
  // Routed descriptions declare no object-level rules, so this is the object.
  options: Object.fromEntries(
    Object.entries(
      (commandOptions(description) as z.ZodObject).shape as Readonly<
        Record<string, z.ZodType>
      >,
    ).map(([key, schema]) => [key, withoutDefault(schema)]),
  ),
});

const schemaSignatures = new WeakMap<z.ZodType, string>();

const schemaSignature = (schema: z.ZodType): string => {
  const cached = schemaSignatures.get(schema);
  if (cached !== undefined) return cached;
  const serialized = JSON.stringify(
    z.toJSONSchema(schema, { unrepresentable: "any" }),
  );
  schemaSignatures.set(schema, serialized);
  return serialized;
};

const simpleSchemasIdentical = (left: z.ZodType, right: z.ZodType): boolean => {
  if (left === right) return true;
  if (
    z.globalRegistry.get(left) !== undefined ||
    z.globalRegistry.get(right) !== undefined
  )
    return false;
  const leftDef = left._zod.def as unknown as Readonly<Record<string, unknown>>;
  const rightDef = right._zod.def as unknown as Readonly<
    Record<string, unknown>
  >;
  if (leftDef.type !== rightDef.type) return false;
  switch (leftDef.type) {
    case "boolean":
    case "string":
      return (
        (leftDef.checks as readonly unknown[] | undefined)?.length ===
          undefined &&
        (rightDef.checks as readonly unknown[] | undefined)?.length ===
          undefined
      );
    case "number":
      return (
        leftDef.format === undefined &&
        rightDef.format === undefined &&
        (leftDef.checks as readonly unknown[] | undefined)?.length ===
          undefined &&
        (rightDef.checks as readonly unknown[] | undefined)?.length ===
          undefined
      );
    case "literal": {
      const leftValues = leftDef.values as readonly unknown[];
      const rightValues = rightDef.values as readonly unknown[];
      return (
        leftValues.length === rightValues.length &&
        leftValues.every((value, index) => Object.is(value, rightValues[index]))
      );
    }
    case "enum": {
      const leftEntries = Object.entries(
        leftDef.entries as Record<string, string | number>,
      );
      const rightEntries = rightDef.entries as Record<string, string | number>;
      return (
        leftEntries.length === Object.keys(rightEntries).length &&
        leftEntries.every(
          ([key, value]) =>
            Object.hasOwn(rightEntries, key) &&
            Object.is(rightEntries[key], value),
        )
      );
    }
    case "optional":
    case "nullable":
    case "readonly":
      return simpleSchemasIdentical(
        leftDef.innerType as z.ZodType,
        rightDef.innerType as z.ZodType,
      );
    default:
      return false;
  }
};

const schemasAgree = (left: z.ZodType, right: z.ZodType): boolean =>
  simpleSchemasIdentical(left, right) ||
  schemaSignature(left) === schemaSignature(right);

/**
 * Routing saw CLI-only options without their defaults; the chosen route's
 * handler receives each omitted one's default, which no contract parse
 * would otherwise restore.
 */
const withCliOnlyDefaults = (
  description: ContractCliDescription,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
  ...values,
  ...Object.fromEntries(
    description.cliOnlyOptions.flatMap(({ key, schema }) =>
      values[key] === undefined ? [[key, schema.parse(undefined)]] : [],
    ),
  ),
});

/**
 * The JSON inputs every route takes under the same key, with the same
 * refusal, so they can be decoded once before a route is chosen.
 */
const sharedJsonInputs = (
  command: string,
  routes: readonly CliCommandRoute[],
): ReadonlySet<string> => {
  const keys = routes.map(({ description }) => jsonInputKeys(description));
  const shared = new Set(
    [...keys[0]!].filter((key) => keys.every((own) => own.has(key))),
  );
  for (const key of shared) {
    const parameters = routes.map(({ description }) =>
      description.parameters.find((parameter) => parameter.key === key)!,
    );
    if (new Set(parameters.map(({ runtimeJson }) => runtimeJson)).size !== 1)
      throw new Error(`${command} routes refuse --${key} differently`);
    // A shared input is checked before the route is chosen, so every route
    // must check it the same way.
    if (
      new Set(parameters.map(({ checkJsonInput }) => checkJsonInput)).size !== 1
    )
      throw new Error(`${command} routes check --${key} differently`);
  }
  return shared;
};

/** The chosen route's JSON inputs that were not decoded before routing. */
const ownJsonInputs = (
  description: ContractCliDescription,
  decoded: ReadonlySet<string>,
): ReadonlySet<string> =>
  new Set([...jsonInputKeys(description)].filter((key) => !decoded.has(key)));

/**
 * Register one CLI command whose input chooses the contract input it runs,
 * such as `analyze` running static JavaScript analysis on an application
 * archive and the binary overview on a program, or `compare-web-captures`
 * comparing recorded scenarios or passive captures by what the documents
 * hold. Each route is projected from its own contract input; the command
 * takes the union of their options, which must agree on every shared key.
 * The first route that owns every given option and takes the input runs; an
 * option the chosen route does not own is refused naming its CLI key and the
 * route that takes it.
 */
export const registerRoutedCommand = (
  cli: CliInstance,
  logger: Logger,
  command: { readonly description: string },
  routes: readonly [...CliCommandRoute[], CliCommandRoute],
): void => {
  // Every route projects the same command, which names itself or is the own
  // command of one route's contract.
  const name = routes[0]!.description.command;
  const shapes = routes.map(({ description }) => {
    if (
      description.command !== name ||
      description.optionConstraints !== undefined ||
      description.checkOptions !== undefined ||
      description.evidenceTargets !== undefined ||
      description.parameters.some(
        ({ selectorOption }) => selectorOption !== undefined,
      )
    )
      throw new Error(
        `${description.contract.name} cannot be routed by ${name}`,
      );
    return commandShape(description);
  });
  const args = shapes[0]!.args;
  const options = new Map<string, z.ZodType>();
  const owners = new Map<string, CliCommandRoute>();
  for (const [index, shape] of shapes.entries()) {
    if (
      index > 0 &&
      (shape.args.length !== args.length ||
        shape.args.some(
          ([key, schema], position) =>
            key !== args[position]![0] ||
            !schemasAgree(schema, args[position]![1]),
        ))
    )
      throw new Error(`${name} routes take different arguments`);
    for (const [key, schema] of Object.entries(shape.options)) {
      const shared = options.get(key);
      if (shared !== undefined && !schemasAgree(shared, schema))
        throw new Error(`${name} routes disagree on --${key}`);
      options.set(key, schema);
      owners.set(key, routes[index]!);
    }
  }
  const owns = (route: CliCommandRoute, key: string): boolean =>
    args.some(([argument]) => argument === key) ||
    Object.hasOwn(shapes[routes.indexOf(route)]!.options, key);
  // Only JSON inputs every route takes alike are decoded before routing.
  const sharedJson = sharedJsonInputs(name, routes);
  registerCliCommand(
    cli,
    name,
    {
      description: command.description,
      args: z.object(Object.fromEntries(args)),
      options: z.object(Object.fromEntries(options)),
      run: ({
        args: given,
        options: chosen,
      }: {
        readonly args: Readonly<Record<string, unknown>>;
        readonly options: Readonly<Record<string, unknown>>;
      }) => {
        const values: Record<string, unknown> = { ...chosen, ...given };
        const supplied = Object.keys(values).filter(
          (key) => values[key] !== undefined,
        );
        return withCommandCancellation((signal) =>
          logCliCommand(logger, name, async () => {
            const shared = await readJsonInputs(
              routes[0]!.description,
              values,
              signal,
              sharedJson,
            );
            if (!shared.ok) return shared.error;
            let route = routes.at(-1)!;
            for (const candidate of routes)
              if (
                candidate.takes !== undefined &&
                supplied.every((key) => owns(candidate, key)) &&
                (await candidate.takes(shared.value))
              ) {
                route = candidate;
                break;
              }
            const { description } = route;
            const refused = supplied.filter((key) => !owns(route, key));
            if (refused.length > 0)
              return projectAnalysisError(
                new AnalysisInputError(
                  description.contract.name,
                  undefined,
                  refused.map((key) => ({
                    path: [key],
                    reason: "invalid_value" as const,
                    message: `--${optionFlagName(key)} requires ${owners.get(key)!.requirement}; the given input selects ${route.requirement}, which does not take it.`,
                  })),
                ),
              );
            const options = description.admitDeliveryOptions(shared.value);
            if (!options.ok) return projectAnalysisError(options.error);
            const read = await readJsonInputs(
              description,
              options.value,
              signal,
              ownJsonInputs(description, sharedJson),
            );
            if (!read.ok) return read.error;
            const admitted = description.admit(read.value);
            if (!admitted.ok)
              return projectCliInputFields(
                projectAnalysisError(admitted.error),
                description.inputBinding,
              );
            const opening = admitOpening(description, values);
            if (!opening.ok) return projectAnalysisError(opening.error);
            return projectCliResult(
              await route.run(admitted.value.input, {
                signal,
                operation: description.contract.name,
                callerInputs: description.callerInputs(values),
                sessionTarget:
                  description.sessionTarget === undefined
                    ? undefined
                    : (values[description.sessionTarget.key] as string),
                evidenceTargets: undefined,
                opening: opening.value,
                delivery: admitted.value.delivery,
                parsed: admitted.value.parsed,
                parseWholeInput: admitted.value.parseWholeInput,
                checked: { ...shared.checked, ...read.checked },
                cliOptions: description.cliOptionValues(
                  withCliOnlyDefaults(description, values),
                ),
              }),
              description.contract.outputSchema,
              {
                ...description.inputBinding,
                operations: contractDescriptionOperations(description),
              },
            );
          }),
        );
      },
    } as never,
    {
      operations: distinctOperations(
        routes.flatMap(({ description }) =>
          contractDescriptionOperations(description),
        ),
      ),
      source: {
        kind: "routed",
        descriptions: routes.map(({ description }) => description),
      },
    },
  );
};
