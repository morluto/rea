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

/** Statically declared environment seeds owned by ANALYSIS_SETTINGS. */
export function parseRuntimeSettingEnvironments(source: string): Set<string>;

/** Detect stale or newly introduced temporary per-call exceptions. */
export function perCallLimitFailures(
  listed: ReadonlyMap<string, string>,
  temporary: ReadonlySet<string>,
): string[];

/** Parse static registry declarations, including external-reader provenance. */
export function parseNumericLimitRegistry(source: string): Array<{
  name: string;
  update_mode: "restart";
  policy: "restart-only" | "per-call";
  read: "startup" | "per-call" | "construction";
  reason: string;
  provenance?: {
    kind: "external-reader" | "generated-control";
    source: string;
    witness: string;
    generator?: string;
    generatorWitness?: string;
  };
}>;

/** Producer paths for numeric limits. Registry text, comments, and allowlists are omitted. */
export function discoverNumericLimitUses(
  files: readonly { readonly path: string; readonly source: string }[],
): Map<
  string,
  {
    readonly path: string;
    read: "module" | "construction" | "unknown";
    readonly sites: Array<{
      readonly path: string;
      readonly read: "module" | "construction" | "unknown";
      readonly offset: number;
      readonly evidence: "direct" | "candidate";
    }>;
  }
> & {
  readonly unresolved: readonly {
    readonly path: string;
    readonly offset: number;
    readonly reason: string;
  }[];
};

/** Why a tracked limit is not an analysis setting, when it is present. */
export function requiredRuntimeLimitFailure(
  name: string,
  presence: { readonly inRuntime: boolean; readonly inRegistry: boolean },
): string | undefined;
