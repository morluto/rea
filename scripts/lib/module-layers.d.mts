export declare const LAYER_ORDER: readonly string[];
export declare const UNIT_LAYERS: Readonly<Record<string, string>>;

/** Single file-to-file upward imports declared as deliberate exceptions. */
export declare const LAYER_EXCEPTIONS: readonly {
  readonly file: string;
  readonly target: string;
  readonly reason: string;
}[];

/** Whether one resolved import is a declared layer exception. */
export function isLayerException(file: string, target: string): boolean;

/** The top-level unit of a production `src/` file, or undefined. */
export function sourceUnit(path: string): string | undefined;

/** Whether a unit is a provider folder. */
export function isProviderUnit(unit: string): boolean;

/**
 * Declared entry files per unit, relative to src/<unit>/: src/resources is
 * reached only through them from every unit, a provider folder from
 * application, composition and the CLI/MCP adapters.
 */
export declare const ENTRY_FILES: Readonly<Record<string, readonly string[]>>;

/**
 * Declared provider-to-provider dependencies: files of `to`, relative to
 * src/<to>/, that `from` may import without a crossProvider count.
 */
export declare const PROVIDER_DEPENDENCIES: readonly {
  readonly from: string;
  readonly to: string;
  readonly files: readonly string[];
  readonly reason: string;
}[];

export interface ProviderBoundaryFacts {
  /** Imports from one provider folder into another, per unit pair. */
  readonly crossProvider: Readonly<Record<string, number>>;
  /**
   * Imports past the entry files: application, composition and adapter
   * imports of a provider file not in its ENTRY_FILES, and any outside import
   * of another non-provider unit's file not in its ENTRY_FILES.
   */
  readonly entry: Readonly<Record<string, number>>;
}

export function providerBoundaryFacts(
  imports: readonly { readonly file: string; readonly target: string }[],
): ProviderBoundaryFacts;

export interface LayerGraphFacts extends ProviderBoundaryFacts {
  readonly undeclared: readonly string[];
  readonly upward: Readonly<Record<string, number>>;
  readonly cycles: readonly string[];
}

export type LayerBaseline = Pick<LayerGraphFacts, "upward" | "cycles"> &
  Partial<ProviderBoundaryFacts>;

export function layerGraphFacts(
  imports: readonly { readonly file: string; readonly target: string }[],
  files?: readonly string[],
): LayerGraphFacts;

export function compareLayerBaseline(
  facts: LayerGraphFacts,
  baseline: LayerBaseline,
): { readonly failures: string[]; readonly lowerable: string[] };

export function lowerLayerBaseline(
  facts: LayerGraphFacts,
  baseline: LayerBaseline,
): Required<LayerBaseline>;
