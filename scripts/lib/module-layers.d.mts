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

/** The shared provider core that every provider folder may import. */
export declare const PROVIDER_CORE: string;

/** Whether a unit is a provider folder (not the shared provider core). */
export function isProviderUnit(unit: string): boolean;

/** Units every other unit reaches only through src/<unit>/index.ts. */
export declare const ENTRY_UNITS: readonly string[];

export interface ProviderBoundaryFacts {
  /** Imports from one provider folder into another, per unit pair. */
  readonly crossProvider: Readonly<Record<string, number>>;
  /**
   * Imports past an entry file: application, composition and adapter imports
   * of a provider file other than its index.ts, and any outside import of an
   * ENTRY_UNITS file other than its index.ts.
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
