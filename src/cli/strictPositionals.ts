import { AsyncLocalStorage } from "node:async_hooks";

import { Errors, Parser, z } from "incur";

import { splitIncurBuiltinArguments } from "../cliBuiltinArguments.js";
import type { CliInstance } from "./types.js";
import { visitRegisteredCommands } from "./visitRegisteredCommands.js";

type ServeOptions = NonNullable<Parameters<CliInstance["serve"]>[1]>;

/** Match the wrapper types the pinned Incur parser unwraps for token binding. */
const tokenType = (field: z.ZodType): z.ZodType => {
  let inner = field;
  while ("innerType" in inner.def) {
    const candidate = inner.def.innerType;
    if (!(candidate instanceof z.ZodType)) break;
    inner = candidate;
  }
  return inner;
};

/** Preserve flag consumption without evaluating command defaults or transforms. */
const optionTokenShape = (
  schema: z.ZodObject,
  strictDryRun: boolean,
): z.ZodObject =>
  z.object(
    Object.fromEntries(
      Object.entries(schema.shape).map(([name, field]) => {
        const inner = tokenType(field);
        const token =
          inner instanceof z.ZodBoolean && !(strictDryRun && name === "dryRun")
            ? z.boolean().optional()
            : inner instanceof z.ZodArray || (strictDryRun && name === "dryRun")
              ? z.array(z.unknown()).optional()
              : z.unknown().optional();
        return [
          name,
          field.meta()?.count === true ? token.meta({ count: true }) : token,
        ];
      }),
    ),
  );

/**
 * Incur 0.6.1 drops unbound positionals and coerces arbitrary boolean text to
 * false. Its public parser owns token binding; inert schemas retain the
 * unbound tail and every dryRun literal before this lossy conversion. Original
 * schemas still own validation, transforms, defaults and actual execution.
 */
export const validateCliArguments = (
  cli: CliInstance,
): ((
  arguments_: readonly string[],
  options: ServeOptions,
  serve: (arguments_: string[], options: ServeOptions) => Promise<void>,
) => Promise<void>) => {
  const invocation = new AsyncLocalStorage<readonly string[]>();
  visitRegisteredCommands(cli, (command) => {
    const fields =
      command.args instanceof z.ZodObject ? command.args.shape : {};
    const entries = Object.entries(fields);
    const optionsSchema =
      command.options instanceof z.ZodObject ? command.options : undefined;
    const dryRunField = optionsSchema?.shape["dryRun"];
    const strictDryRun =
      dryRunField !== undefined &&
      tokenType(dryRunField) instanceof z.ZodBoolean;
    const final = entries.at(-1)?.[1];
    const variadic =
      final !== undefined && tokenType(final) instanceof z.ZodArray;
    // A final array consumes the tail, but must still admit dry-run literals.
    if (variadic && !strictDryRun) return;
    let tail = "__rea_unbound_positionals";
    while (Object.hasOwn(fields, tail)) tail += "_";
    command.middleware = [
      async (context, next) => {
        const tokens = invocation.getStore();
        if (tokens !== undefined) {
          // Only the resolved command needs an inert token-binding schema.
          // Keep the original schema references, but do not prepare every
          // registered command for each one-shot invocation.
          const args = z.object({
            ...Object.fromEntries(
              entries.map(([name, field]) => [
                name,
                tokenType(field) instanceof z.ZodArray
                  ? z.array(z.unknown()).optional()
                  : z.unknown().optional(),
              ]),
            ),
            ...(variadic ? {} : { [tail]: z.array(z.string()).optional() }),
          });
          const options =
            optionsSchema === undefined
              ? undefined
              : optionTokenShape(optionsSchema, strictDryRun);
          // Incur supplies the invoked path, including aliases, after resolving
          // groups. No second router decides which command receives the tokens.
          const rest = tokens.slice(context.command.split(" ").length);
          // Only this preflight copy expands bare booleans. Array binding keeps
          // all explicit literals without coercion, including overridden ones.
          // Flag-shaped string data still belongs to its consuming option.
          const admitted = strictDryRun
            ? rest.map((token) =>
                token === "--dry-run" || token === "--dryRun"
                  ? "--dry-run=true"
                  : token === "--no-dry-run" || token === "--no-dryRun"
                    ? "--dry-run=false"
                    : token,
              )
            : rest;
          const parsed = Parser.parse(admitted, {
            args,
            options,
            alias: command.alias as Record<string, string> | undefined,
          });
          const dryRunValues: unknown =
            "dryRun" in parsed.options ? parsed.options.dryRun : undefined;
          if (
            strictDryRun &&
            Array.isArray(dryRunValues) &&
            dryRunValues.some((value) => value !== "true" && value !== "false")
          )
            throw new Errors.IncurError({
              code: "PARSE_ERROR",
              message: "Invalid --dry-run value; use true or false.",
            });
          const surplus: unknown = parsed.args[tail];
          if (Array.isArray(surplus) && surplus.length > 0)
            throw new Errors.ParseError({
              message: `Unexpected positional arguments: ${surplus.map((value) => JSON.stringify(value)).join(" ")}. Use '${context.displayName} ${context.command} --help' for the declared argument shape.`,
            });
        }
        await next();
      },
      ...(command.middleware ?? []),
    ];
  });
  return (arguments_, options, serve) =>
    invocation.run(splitIncurBuiltinArguments(arguments_).command, () =>
      serve([...arguments_], options),
    );
};
