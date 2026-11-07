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
const optionTokenShape = (schema: z.ZodObject): z.ZodObject =>
  z.object(
    Object.fromEntries(
      Object.entries(schema.shape).map(([name, field]) => {
        const inner = tokenType(field);
        const token =
          inner instanceof z.ZodBoolean
            ? z.boolean().optional()
            : inner instanceof z.ZodArray
              ? z.array(z.unknown()).optional()
              : z.unknown().optional();
        return [
          name,
          field.meta()?.count === true ? token.meta({ count: true }) : token,
        ];
      }),
    ),
  );

/** Ask the SDK to resolve a single explicit option, without command defaults or transforms. */
const boundOption = (
  token: string,
  options: z.ZodObject,
  alias: Record<string, string> | undefined,
): string | undefined => {
  try {
    return Object.keys(Parser.parse([token], { options, alias }).options)[0];
  } catch (cause) {
    // This token can still be data consumed by another option. The complete
    // parse below owns unknown flags and their actual token boundaries.
    if (cause instanceof Errors.ParseError) return undefined;
    throw cause;
  }
};

/** Retain each explicit boolean literal only in the inert preflight parse. */
const retainBooleanLiterals = (
  tokens: string[],
  options: z.ZodObject | undefined,
  booleans: ReadonlySet<string>,
  alias: Record<string, string> | undefined,
) => {
  const literals: { key: string; flag: string }[] = [];
  if (options === undefined || booleans.size === 0)
    return { tokens, options, literals };
  const reserved = new Set(Object.keys(options.shape));
  for (const token of tokens) {
    if (!token.startsWith("--")) continue;
    const equals = token.indexOf("=");
    reserved.add(token.slice(2, equals < 0 ? undefined : equals));
  }
  let index = 0;
  const retained = tokens.map((token) => {
    if (!token.startsWith("--")) return token;
    const equals = token.indexOf("=");
    if (equals < 0) return token;
    const name = boundOption(token, options, alias);
    if (name === undefined || !booleans.has(name)) return token;
    let key: string;
    do {
      key = `__rea_boolean_literal_${String(index++)}`;
    } while (
      reserved.has(key) ||
      boundOption(`--${key}=false`, options, alias) !== undefined
    );
    reserved.add(key);
    const replacement = `--${key}${token.slice(equals)}`;
    literals.push({
      key,
      flag: name === "dryRun" ? "--dry-run" : token.slice(0, equals),
    });
    return replacement;
  });
  return {
    tokens: retained,
    options: options.extend(
      Object.fromEntries(
        literals.map(({ key }) => [key, z.unknown().optional()]),
      ),
    ),
    literals,
  };
};

/**
 * Incur 0.6.1 drops unbound positionals and coerces arbitrary boolean text to
 * false. Its public parser owns token binding; inert schemas retain the
 * unbound tail and every explicit boolean literal before this lossy conversion. Original
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
    const booleans = new Set(
      Object.entries(optionsSchema?.shape ?? {})
        .filter(([, field]) => {
          const inner = tokenType(field);
          return inner instanceof z.ZodBoolean && inner.def.coerce !== true;
        })
        .map(([name]) => name),
    );
    const final = entries.at(-1)?.[1];
    const variadic =
      final !== undefined && tokenType(final) instanceof z.ZodArray;
    // A final array consumes the tail, but explicit boolean literals still need admission.
    if (variadic && booleans.size === 0) return;
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
              : optionTokenShape(optionsSchema);
          // Incur supplies the invoked path, including aliases, after resolving
          // groups. No second router decides which command receives the tokens.
          const rest = tokens.slice(context.command.split(" ").length);
          const alias = command.alias as Record<string, string> | undefined;
          const admitted = retainBooleanLiterals(
            rest,
            options,
            booleans,
            alias,
          );
          const parsed = Parser.parse(admitted.tokens, {
            args,
            options: admitted.options,
            alias,
          });
          for (const { key, flag } of admitted.literals) {
            const value: unknown = Reflect.get(parsed.options, key);
            if (
              Object.hasOwn(parsed.options, key) &&
              value !== "true" &&
              value !== "false"
            )
              throw new Errors.IncurError({
                code: "PARSE_ERROR",
                message: `Invalid ${flag} value; use true or false.`,
              });
          }
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
