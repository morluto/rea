const UNSUPPORTED_OUTPUT_COMBINATION_MESSAGE =
  "Token windows cannot preserve structured output. Remove --token-limit/--token-offset and use --filter-output or command pagination.";

type StructuredOutputFormat = "json" | "jsonl" | "yaml";
const INCUR_OUTPUT_FORMATS = new Set(["toon", "json", "yaml", "md", "jsonl"]);

export type CliOutputArgumentValidation =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly format: StructuredOutputFormat;
      readonly code: "UNSUPPORTED_OUTPUT_COMBINATION";
      readonly message: string;
    };

interface ParsedCliOutputArguments {
  readonly filterOutput: string | undefined;
  readonly format: string;
  readonly fullOutput: boolean;
  readonly parseError: boolean;
  readonly tokenCount: boolean;
  readonly tokenWindow: boolean;
}

/** Read effective Incur output controls at the executable boundary. */
export const parseCliOutputArguments = (
  arguments_: readonly string[],
): ParsedCliOutputArguments => {
  let format: string = "toon";
  let filterOutput: string | undefined;
  let fullOutput = false;
  let tokenCount = false;
  let tokenWindow = false;
  const parsed = (parseError: boolean): ParsedCliOutputArguments => ({
    filterOutput,
    format,
    fullOutput,
    parseError,
    tokenCount,
    tokenWindow: parseError ? false : tokenWindow,
  });
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    // Incur scans builtins across `--` and accepts only spaced value forms.
    // Mirror those effective values at the executable output boundary.
    if (argument === "--json") {
      format = "json";
      continue;
    }
    if (argument === "--format") {
      const value = arguments_[index + 1];
      if (value) {
        // Incur stops parsing at an invalid format before applying any later
        // output controls. Let it report that malformed flag itself.
        if (!INCUR_OUTPUT_FORMATS.has(value)) return parsed(true);
        format = value;
        index += 1;
      }
      continue;
    }
    if (argument === "--filter-output") {
      if (arguments_[index + 1]) {
        filterOutput = arguments_[index + 1];
        index += 1;
      }
      continue;
    }
    if (argument === "--token-limit" || argument === "--token-offset") {
      const value = arguments_[index + 1];
      if (value) {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue) || value.trim() === "")
          return parsed(true);
        tokenWindow = true;
        index += 1;
      }
      continue;
    }
    if (argument === "--full-output") fullOutput = true;
    if (argument === "--token-count") tokenCount = true;
  }
  return parsed(false);
};

/** Reject text-window controls that would corrupt a structured document. */
export const validateCliOutputArguments = (
  arguments_: readonly string[],
): CliOutputArgumentValidation => {
  const { format, parseError, tokenWindow } =
    parseCliOutputArguments(arguments_);
  if (parseError) return { ok: true };
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

/** Preserve a complete document when Incur filters the entire result away. */
export const renderEmptyFilteredCliOutput = (
  arguments_: readonly string[],
): string | undefined => {
  const { filterOutput, format, parseError } =
    parseCliOutputArguments(arguments_);
  if (parseError) return undefined;
  if (
    filterOutput &&
    (format === "json" || format === "jsonl" || format === "yaml")
  )
    return "{}\n";
  return undefined;
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
