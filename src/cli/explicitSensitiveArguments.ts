import { AsyncLocalStorage } from "node:async_hooks";

import { Errors, type MiddlewareHandler } from "incur";
import { z } from "zod";

import {
  readCliOutputArguments,
  renderCliOutputArgumentError,
} from "../cliOutput.js";
import {
  declaredSensitiveValues,
  type CliGlobalArguments,
} from "../cliBuiltinArguments.js";
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";
import type { CliInstance } from "./types.js";
import { visitRegisteredCommands } from "./visitRegisteredCommands.js";

/** Repeatable option whose literals the command and its CLI diagnostics exclude. */
export const explicitSensitiveValueOptions = {
  sensitiveValue: z
    .array(z.string().min(1))
    .default([])
    .describe(
      "Literal string values explicitly marked sensitive; repeat as needed",
    ),
};

const OPTION =
  "sensitiveValue" satisfies keyof typeof explicitSensitiveValueOptions;
type ServeOptions = NonNullable<Parameters<CliInstance["serve"]>[1]>;

/** Share the executable boundary's output admission and structured diagnostics. */
const reportDeclaredOutputRejection = (
  global: CliGlobalArguments,
  options: ServeOptions,
): boolean => {
  const validation = readCliOutputArguments(global).validation;
  if (validation.ok) return false;
  (options.stdout ?? ((text: string) => process.stdout.write(text)))(
    renderCliOutputArgumentError(validation),
  );
  (options.exit ?? ((code: number) => process.exit(code)))(1);
  return true;
};

/** Keep the thrown type, code and exit status; exclude declared literals from text. */
const withoutDeclaredText = (
  error: unknown,
  values: readonly string[],
): unknown => {
  const text = (value: string): string => redactExplicitText(value, values);
  if (!(error instanceof Error)) {
    const description = String(error);
    return text(description) === description ? error : text(description);
  }
  const message = text(error.message);
  if (error instanceof Errors.ValidationError) {
    // Paths and expectations name the command's own schema.
    const fieldErrors = error.fieldErrors.map((field) => ({
      ...field,
      received: text(field.received),
      message: text(field.message),
    }));
    return message === error.message &&
      fieldErrors.every(
        (field, index) =>
          field.received === error.fieldErrors[index]!.received &&
          field.message === error.fieldErrors[index]!.message,
      )
      ? error
      : new Errors.ValidationError({ message, fieldErrors });
  }
  if (error instanceof Errors.IncurError) {
    const hint = error.hint === undefined ? undefined : text(error.hint);
    return message === error.message && hint === error.hint
      ? error
      : new Errors.IncurError({
          code: error.code,
          message,
          ...(hint === undefined ? {} : { hint }),
          retryable: error.retryable,
          ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
        });
  }
  if (message === error.message) return error;
  return error instanceof Errors.ParseError
    ? new Errors.ParseError({ message })
    : new Error(message);
};

/**
 * Apply `--sensitive-value` declarations to diagnostics produced before the
 * command's own service sees them: rejected output values and the parse,
 * validation and thrown failures of every command that accepts the option.
 * Diagnostic text is redacted whole; codes, keys and rendering stay intact.
 * Returns the serve step; command results keep their own redaction owners.
 */
export const excludeDeclaredSensitiveArguments = (
  cli: CliInstance,
): ((
  global: CliGlobalArguments,
  options: ServeOptions,
  serve: (options: ServeOptions) => Promise<void>,
) => Promise<void>) => {
  const declarations = new AsyncLocalStorage<readonly string[]>();
  const excludeFromFailures: MiddlewareHandler = async (_context, next) => {
    const values = declarations.getStore();
    if (values === undefined) return next();
    try {
      await next();
    } catch (error) {
      throw withoutDeclaredText(error, values);
    }
  };
  visitRegisteredCommands(cli, (command) => {
    if (
      command.options instanceof z.ZodObject &&
      Object.hasOwn(command.options.shape, OPTION)
    )
      // Outside the command middleware, so its failures are covered as well
      // as the parsing and run that Incur executes inside the chain.
      command.middleware = [excludeFromFailures, ...(command.middleware ?? [])];
  });
  return async (global, options, serve) => {
    const values = declaredSensitiveValues(global.command);
    if (values.length === 0) return serve(options);
    if (reportDeclaredOutputRejection(global, options)) return;
    return declarations.run(values, () => serve(options));
  };
};
