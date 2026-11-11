/** Relative path of the registry. Its text is a declaration, not a producer. */
export const NUMERIC_LIMIT_DECLARATION: "src/domain/numericLimitRegistry.ts";

/** Limits that must become analysis settings and cannot be registry exceptions. */
export const REQUIRED_RUNTIME_LIMITS: readonly [
  "REA_NTFS_MFT_MAX_FILE_BYTES",
  "REA_REGF_HIVE_MAX_FILE_BYTES",
  "REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES",
];

/** True for a numeric `REA_` limit, including the documented endpoint-candidate count. */
export function isNumericLimit(name: string): boolean;

/** Producer paths for numeric limits. Registry text, comments, and allowlists are omitted. */
export function discoverNumericLimitUses(
  files: readonly { readonly path: string; readonly source: string }[],
): Map<string, string>;

/** Why a tracked limit is not an analysis setting, when it is present. */
export function requiredRuntimeLimitFailure(
  name: string,
  presence: { readonly inRuntime: boolean; readonly inRegistry: boolean },
): string | undefined;
