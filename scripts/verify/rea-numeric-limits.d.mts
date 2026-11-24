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

/** One default, floor, and maximum from the numeric inventory tables. */
export type DocumentedNumericLimit = {
  readonly name: string;
  readonly section: string;
  readonly defaultCell: string;
  readonly floorCell: string;
  readonly maximumCell: string;
};

/** Default, floor, and maximum exported by the analysis-setting registry or an owner. */
export type ExportedNumericLimit = {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly defaultValue: number | null;
  readonly minimum: number;
  readonly maximum: number;
};

/** Read default, floor, and maximum from the three numeric inventory tables. */
export function parseDocumentedNumericLimits(
  markdown: string,
): DocumentedNumericLimit[];

/**
 * Read one documented cell.
 * A fraction is unreadable. Prose is allowed only after a complete integer and whitespace.
 */
export function documentedLimitCell(
  cell: string,
  names: Readonly<Record<string, number>>,
):
  | { readonly ok: true; readonly value: number | null }
  | { readonly ok: false; readonly reason: string };

/**
 * Compare documented limits with exported bounds.
 * Each failure names the limit and both values.
 */
export function compareDocumentedNumericLimits(
  rows: readonly DocumentedNumericLimit[],
  bounds: readonly ExportedNumericLimit[],
  names: Readonly<Record<string, number>>,
): string[];

/**
 * Bounds ANALYSIS_SETTINGS and the restart-only owners export.
 * `failures` names a registry entry that has no exported bound.
 */
export function loadExportedNumericLimitBounds(): Promise<{
  readonly bounds: readonly ExportedNumericLimit[];
  readonly names: Readonly<Record<string, number>>;
  readonly failures: readonly string[];
}>;
