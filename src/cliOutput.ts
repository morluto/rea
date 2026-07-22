const SAFE_VALIDATION_MESSAGE =
  "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again.";
const UNSUPPORTED_OUTPUT_COMBINATION_MESSAGE =
  "Token windows cannot preserve structured output. Remove --token-limit/--token-offset and use --filter-output or command pagination.";

type StructuredOutputFormat = "json" | "jsonl" | "yaml";

export type CliOutputArgumentValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly format: StructuredOutputFormat;
      readonly code: "UNSUPPORTED_OUTPUT_COMBINATION";
      readonly message: string;
    };

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validationError = (value: unknown): JsonRecord | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.code === "VALIDATION_ERROR") return value;
  if (value.ok === false && isRecord(value.error))
    return value.error.code === "VALIDATION_ERROR" ? value.error : undefined;
  return undefined;
};

/** Reject text-window controls that would corrupt a structured document. */
export const validateCliOutputArguments = (
  arguments_: readonly string[],
): CliOutputArgumentValidation => {
  let format: string = "toon";
  let tokenWindow = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--") break;
    if (argument === "--json") {
      format = "json";
      continue;
    }
    if (argument === "--format") {
      const value = arguments_[index + 1];
      if (value !== undefined) {
        format = value;
        index += 1;
      }
      continue;
    }
    if (argument?.startsWith("--format=")) {
      format = argument.slice("--format=".length);
      continue;
    }
    if (argument === "--token-limit" || argument === "--token-offset") {
      if (arguments_[index + 1] !== undefined) {
        tokenWindow = true;
        index += 1;
      }
      continue;
    }
    if (
      argument?.startsWith("--token-limit=") ||
      argument?.startsWith("--token-offset=")
    )
      tokenWindow = true;
  }
  if (
    tokenWindow &&
    (format === "json" || format === "jsonl" || format === "yaml")
  )
    return {
      ok: false,
      format,
      code: "UNSUPPORTED_OUTPUT_COMBINATION",
      message: UNSUPPORTED_OUTPUT_COMBINATION_MESSAGE,
    };
  return { ok: true };
};

/** Render one complete structured error before command execution. */
export const renderCliOutputArgumentError = (
  error: Exclude<CliOutputArgumentValidation, { readonly ok: true }>,
): string => {
  const value = {
    ok: false,
    error: { code: error.code, message: error.message },
  };
  if (error.format === "yaml")
    return `ok: false\nerror:\n  code: ${error.code}\n  message: ${JSON.stringify(error.message)}\n`;
  return `${JSON.stringify(value)}\n`;
};

/** Remove validator internals from Incur's caller-visible CLI output. */
export const sanitizeCliOutput = (output: string): string => {
  const trimmed = output.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const error = validationError(parsed);
      if (error !== undefined) {
        const safeError = {
          code: "VALIDATION_ERROR",
          message: SAFE_VALIDATION_MESSAGE,
        };
        if (error === parsed) return `${JSON.stringify(safeError)}\n`;
        if (!isRecord(parsed)) return output;
        return `${JSON.stringify({ ...parsed, error: safeError })}\n`;
      }
    } catch {
      return output;
    }
    return output;
  }
  if (
    /^ok: false\r?\nerror:\r?\n  code: VALIDATION_ERROR(?:\r?\n|$)/u.test(
      trimmed,
    )
  )
    return `ok: false\nerror:\n  code: VALIDATION_ERROR\n  message: "${SAFE_VALIDATION_MESSAGE}"\n`;
  if (!/^code: VALIDATION_ERROR(?:\r?\n|$)/u.test(trimmed)) return output;
  return `code: VALIDATION_ERROR\nmessage: "${SAFE_VALIDATION_MESSAGE}"\n`;
};
