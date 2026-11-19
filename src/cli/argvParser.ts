import { z } from "zod";

import { err, ok, type Result } from "../domain/result.js";
import {
  declaredOptionType,
  isCountOption,
  optionFlagName,
} from "./optionFields.js";

/**
 * REA's argv parser for one command: binds tokens to the command's
 * positionals and options, then validates them with the command's schemas.
 * Option keys are camelCase; each is spelled `--kebab-case` on the command
 * line and also accepted as `--camelCase`. A boolean option is set by its
 * bare flag and cleared by `--no-<flag>`; `--flag=value` and `--flag value`
 * both bind a value; an array option collects every occurrence; a short
 * alias may be stacked (`-ab`) when all but the last are booleans or
 * counts; a count option adds one per occurrence (`-vvv`). `--` is
 * not a separator here: after the command it is an unknown flag. The
 * messages and field errors match what REA has always printed (#11654).
 */

/** One field that failed validation, as REA prints it. */
export interface CliFieldError {
  readonly code: string;
  /** The caller did not supply the field at all. */
  readonly missing: boolean;
  /** Dotted path within the positionals or options. */
  readonly path: string;
  readonly expected: string;
  readonly received: string;
  readonly message: string;
}

/**
 * Why argv was refused: a token the parser cannot bind (an unknown flag or a
 * missing value), or bound positionals or options their schema refused.
 */
export type CliArgvFailure =
  | { readonly kind: "parse"; readonly message: string }
  | { readonly kind: "surplus"; readonly message: string }
  | { readonly kind: "dry_run"; readonly message: string }
  | {
      readonly kind: "validation";
      readonly message: string;
      readonly fieldErrors: readonly CliFieldError[];
      /** Original parser facts for command-specific safe constraint projection. */
      readonly issues: readonly z.core.$ZodIssue[];
    };

const parseFailure = (message: string): Result<never, CliArgvFailure> =>
  err({ kind: "parse", message });

export interface CliArgvSchemas {
  /** Positionals in argv order; a final array field takes the rest. */
  readonly args?: z.ZodObject | undefined;
  readonly options?: z.ZodObject | undefined;
  /** Short alias by option key, such as `{ yes: "y" }`. */
  readonly alias?: Readonly<Record<string, string>> | undefined;
}

export interface CliParsedArgv {
  readonly args: Record<string, unknown>;
  readonly options: Record<string, unknown>;
}

const fieldOf = (
  schema: z.ZodObject | undefined,
  name: string,
): z.ZodType | undefined =>
  schema === undefined
    ? undefined
    : (schema.shape as Readonly<Record<string, z.ZodType>>)[name];

const isBoolean = (schema: z.ZodObject | undefined, name: string): boolean => {
  const field = fieldOf(schema, name);
  return (
    field !== undefined && declaredOptionType(field) instanceof z.ZodBoolean
  );
};

/** A count option (`.meta({ count: true })`) adds one per occurrence. */
const isCount = (schema: z.ZodObject | undefined, name: string): boolean => {
  const field = fieldOf(schema, name);
  return field !== undefined && isCountOption(field);
};

const isArray = (schema: z.ZodObject | undefined, name: string): boolean => {
  const field = fieldOf(schema, name);
  return field !== undefined && declaredOptionType(field) instanceof z.ZodArray;
};

/** Number and boolean options arrive as text; the schema validates the result. */
const coerce = (value: unknown, schema: z.ZodObject, name: string): unknown => {
  const field = fieldOf(schema, name);
  if (field === undefined || typeof value !== "string") return value;
  const type = declaredOptionType(field);
  if (type instanceof z.ZodNumber) return Number(value);
  if (type instanceof z.ZodBoolean) return value === "true";
  return value;
};

/** Whether the raw input holds the issue's whole path. */
const hasPath = (data: unknown, path: readonly PropertyKey[]): boolean => {
  let current = data;
  for (const part of path) {
    if (typeof current !== "object" || current === null) return false;
    if (!(part in current)) return false;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return true;
};

/** Validate with `schema`, reporting each issue as a field error. */
export const validateCliInputs = (
  schema: z.ZodObject,
  data: Readonly<Record<string, unknown>>,
): Result<Record<string, unknown>, CliArgvFailure> => {
  const parsed = schema.safeParse(data);
  if (parsed.success) return ok(parsed.data);
  const { issues } = parsed.error;
  return err({
    kind: "validation",
    issues,
    message:
      issues.map(({ message }) => message).join("; ") || "Validation failed",
    fieldErrors: issues.map((issue) => ({
      code: issue.code,
      missing: !hasPath(data, issue.path),
      path: issue.path.join("."),
      expected: stringField(issue, "expected"),
      received: stringField(issue, "received"),
      message: issue.message,
    })),
  });
};

/** Zod reports `expected` (and older issues `received`) as text when present. */
const stringField = (issue: object, key: string): string =>
  (Reflect.get(issue, key) as string | undefined) ?? "";

/** Bind and validate one command's argv. */
export const parseCliArgv = (
  argv: readonly string[],
  schemas: CliArgvSchemas,
): Result<CliParsedArgv, CliArgvFailure> => {
  const { args: argsSchema, options: optionsSchema, alias } = schemas;
  const known = new Set(
    optionsSchema === undefined ? [] : Object.keys(optionsSchema.shape),
  );
  const camelOf = new Map(
    [...known].flatMap((name) =>
      optionFlagName(name) === name
        ? []
        : [[optionFlagName(name), name] as const],
    ),
  );
  const optionName = (raw: string): string | undefined => {
    const name = camelOf.get(raw) ?? raw;
    return known.has(name) ? name : undefined;
  };
  const aliasName = new Map(
    Object.entries(alias ?? {}).map(([name, short]) => [short, name] as const),
  );
  const positionals: string[] = [];
  const options: Record<string, unknown> = {};
  let invalidDryRun = false;
  const set = (name: string, value: string): void => {
    if (name === "dryRun" && isBoolean(optionsSchema, name))
      invalidDryRun ||= value !== "true" && value !== "false";
    if (!isArray(optionsSchema, name)) {
      options[name] = value;
      return;
    }
    const existing = options[name];
    if (Array.isArray(existing)) existing.push(value);
    else options[name] = [value];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token.startsWith("--no-") && token.length > 5) {
      const name = optionName(token.slice(5));
      if (name === undefined) return parseFailure(`Unknown flag: ${token}`);
      options[name] = false;
    } else if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      if (equals !== -1) {
        const raw = token.slice(2, equals);
        const name = optionName(raw);
        if (name === undefined) return parseFailure(`Unknown flag: --${raw}`);
        set(name, token.slice(equals + 1));
        continue;
      }
      const name = optionName(token.slice(2));
      if (name === undefined) return parseFailure(`Unknown flag: ${token}`);
      if (isCount(optionsSchema, name)) {
        options[name] = ((options[name] as number | undefined) ?? 0) + 1;
        continue;
      }
      if (isBoolean(optionsSchema, name)) {
        options[name] = true;
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined)
        return parseFailure(`Missing value for flag: ${token}`);
      set(name, value);
      index += 1;
    } else if (token.startsWith("-") && token.length >= 2) {
      const shorts = token.slice(1);
      for (const [position, short] of [...shorts].entries()) {
        const name = aliasName.get(short);
        if (name === undefined) return parseFailure(`Unknown flag: -${short}`);
        if (isCount(optionsSchema, name)) {
          options[name] = ((options[name] as number | undefined) ?? 0) + 1;
          continue;
        }
        if (isBoolean(optionsSchema, name)) {
          options[name] = true;
          continue;
        }
        if (position !== shorts.length - 1)
          return parseFailure(
            `Non-boolean flag -${short} must be last in a stacked alias`,
          );
        const value = argv[index + 1];
        if (value === undefined)
          return parseFailure(`Missing value for flag: -${short}`);
        set(name, value);
        index += 1;
      }
    } else {
      positionals.push(token);
    }
  }
  // Check retained token facts before defaults or transforms can run. A later
  // valid occurrence must not hide an earlier invalid dry-run literal.
  if (invalidDryRun)
    return err({
      kind: "dry_run",
      message: "Invalid --dry-run value; use true or false.",
    });
  const keys = Object.keys(argsSchema?.shape ?? {});
  const last = keys.at(-1);
  const variadic = last !== undefined && isArray(argsSchema, last);
  if (!variadic && positionals.length > keys.length)
    return err({
      kind: "surplus",
      message: `Unexpected positional arguments: ${positionals
        .slice(keys.length)
        .map((value) => JSON.stringify(value))
        .join(" ")}.`,
    });
  const rawArgs: Record<string, unknown> = {};
  if (argsSchema !== undefined) {
    for (const [position, key] of keys.entries()) {
      if (isArray(argsSchema, key)) {
        if (position !== keys.length - 1)
          throw new Error(
            `Variadic arg "${key}" must be the last key in the args schema`,
          );
        const rest = positionals.slice(position);
        if (rest.length > 0) rawArgs[key] = rest;
      } else if (positionals[position] !== undefined)
        rawArgs[key] = positionals[position];
    }
  }
  // Positionals are validated first; their failure is reported alone.
  const parsedArgs =
    argsSchema === undefined ? ok({}) : validateCliInputs(argsSchema, rawArgs);
  if (!parsedArgs.ok) return parsedArgs;
  if (optionsSchema === undefined)
    return ok({ args: parsedArgs.value, options: {} });
  for (const [name, value] of Object.entries(options))
    options[name] = coerce(value, optionsSchema, name);
  const parsedOptions = validateCliInputs(optionsSchema, options);
  return parsedOptions.ok
    ? ok({ args: parsedArgs.value, options: parsedOptions.value })
    : parsedOptions;
};
