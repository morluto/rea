/** Read the string code reported by a caught object, including a plain object. */
export const reportedSystemCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause))
    return undefined;
  const code: unknown = cause.code;
  return typeof code === "string" ? code : undefined;
};
