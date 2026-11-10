/** Relative path of the registry. Its text is a declaration, not a producer. */
export const NUMERIC_LIMIT_DECLARATION: "src/domain/numericLimitRegistry.ts";

/** True for a numeric `REA_` limit, including the documented endpoint-candidate count. */
export function isNumericLimit(name: string): boolean;

/** Producer paths for numeric limits. Registry declarations are omitted. */
export function discoverNumericLimitUses(
  files: readonly { readonly path: string; readonly source: string }[],
): Map<string, string>;
