export const FIXED_CEILING_CLASSES: ReadonlySet<string>;
export function compareFixedCeilings(
  declarations: ReadonlyMap<string, ReadonlyMap<string, number>>,
  registry: Record<
    string,
    Record<string, { class?: unknown; reason?: unknown; issue?: unknown }>
  >,
): string[];
