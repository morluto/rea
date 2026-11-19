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

/** Why a tracked limit is not an analysis setting, when it is present. */
export function requiredRuntimeLimitFailure(
  name: string,
  presence: { readonly inRuntime: boolean; readonly inRegistry: boolean },
): string | undefined;
