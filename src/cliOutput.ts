const SAFE_VALIDATION_MESSAGE =
  "REA could not read the command arguments. Run `rea --help`, correct the arguments, then try again.";

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
