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

export interface LayerGraphFacts {
  readonly undeclared: readonly string[];
  readonly upward: Readonly<Record<string, number>>;
  readonly cycles: readonly string[];
}

export function layerGraphFacts(
  imports: readonly { readonly file: string; readonly target: string }[],
  files?: readonly string[],
): LayerGraphFacts;

export function compareLayerBaseline(
  facts: LayerGraphFacts,
  baseline: Pick<LayerGraphFacts, "upward" | "cycles">,
): { readonly failures: string[]; readonly lowerable: string[] };

export function lowerLayerBaseline(
  facts: LayerGraphFacts,
  baseline: Pick<LayerGraphFacts, "upward" | "cycles">,
): Pick<LayerGraphFacts, "upward" | "cycles">;
