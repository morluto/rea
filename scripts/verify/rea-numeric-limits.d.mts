/** Statically declared environment seeds owned by ANALYSIS_SETTINGS. */
export function parseRuntimeSettingEnvironments(source: string): Set<string>;

/** Parse static registry declarations, including external-reader provenance. */
export function parseNumericLimitRegistry(source: string): Array<{
  name: string;
  update_mode: "restart";
  policy: "restart-only";
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
    readonly line: number;
    readonly column: number;
    readonly reason: string;
  }[];
};

/** A required runtime limit that is missing or is not an analysis setting. */
export type RequiredRuntimeLimitFailure = {
  readonly code:
    | "required_runtime_limit_missing"
    | "required_runtime_limit_not_analysis_setting";
  readonly name: string;
};

/**
 * Classify one required runtime limit.
 * Absence from source, the exception registry, and ANALYSIS_SETTINGS is
 * `required_runtime_limit_missing`.
 */
export function requiredRuntimeLimitFailure(
  name: string,
  presence: {
    readonly inSource: boolean;
    readonly inRuntime: boolean;
    readonly inRegistry: boolean;
  },
): RequiredRuntimeLimitFailure | undefined;
