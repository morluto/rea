export const FIXED_CEILING_CLASSES: ReadonlySet<string>;
export function compareFixedCeilings(
  declarations: ReadonlyMap<string, ReadonlyMap<string, number>>,
  registry: Record<
    string,
    Record<string, { class?: unknown; reason?: unknown; issue?: unknown }>
  >,
): string[];
export function compareAuthoredOnlyRefusals(
  counts: ReadonlyMap<string, number>,
  baseline: Record<string, number>,
  shrink: boolean,
): { failures: string[]; baseline: Record<string, number> };
export function checkAuthoredOnlyBaseline(
  path: string,
  counts: ReadonlyMap<string, number>,
  shrink: boolean,
): Promise<string[]>;
