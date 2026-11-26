const readStringCode = (value: object): string | undefined => {
  if (!("code" in value)) return undefined;
  const code: unknown = value.code;
  return typeof code === "string" ? code : undefined;
};

/** Read the string code reported by a caught object, including a plain object. */
export const reportedSystemCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null
    ? readStringCode(cause)
    : undefined;

/** Read a system code only when the caller caught an Error. */
export const systemCodeFromError = (cause: unknown): string | undefined =>
  cause instanceof Error ? readStringCode(cause) : undefined;
