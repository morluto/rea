import type { RasterRegistryFamilyReport } from "../../domain/rasterRegistryFamily.js";
import type { StructuredRasterRange } from "../../domain/structuredRasterDiscovery.js";
/** Project one bounded page without losing alternative registries or changing coordinate systems twice. */
export function projectRasterFamily(
  family: RasterRegistryFamilyReport,
  logicalBase: number,
  selectedDescriptors: ReadonlySet<number>,
  sourceMapping: (
    offset: number,
    length: number,
  ) => { ranges: StructuredRasterRange[]; complete: boolean },
) {
  const range = (r: StructuredRasterRange) => ({
    ...r,
    offset: r.offset + logicalBase,
  });
  const nullable = (r: StructuredRasterRange | null) =>
    r === null ? null : range(r);
  return {
    ...family,
    coverage: {
      ...family.coverage,
      nextOffset:
        family.coverage.nextOffset === null
          ? null
          : family.coverage.nextOffset + logicalBase,
    },
    registries: family.registries.map((registry) => {
      const selected = registry.bindings.filter((binding) =>
        selectedDescriptors.has(binding.descriptorOffset),
      );
      return {
        ...registry,
        range: range(registry.range),
        pointerBias: registry.pointerBias - logicalBase,
        rows: registry.rows.map((row) => ({
          ...row,
          range: range(row.range),
          tableRange: range(row.tableRange),
          countRange: nullable(row.countRange),
          dynamicOwnerRange: nullable(row.dynamicOwnerRange),
        })),
        palettePointerRange: nullable(registry.palettePointerRange),
        palettes: registry.palettes.map((palette) => ({
          ...palette,
          range: range(palette.range),
          sourceMapping: sourceMapping(
            palette.range.offset,
            palette.range.length,
          ),
        })),
        availableBindings: registry.bindings.length,
        bindingsTruncated: selected.length < registry.bindings.length,
        bindings: selected.map((binding) => ({
          ...binding,
          descriptorOffset: binding.descriptorOffset + logicalBase,
          payloadRange: range(binding.payloadRange),
          lookupRange: nullable(binding.lookupRange),
          payloadSourceMapping: sourceMapping(
            binding.payloadRange.offset,
            binding.payloadRange.length,
          ),
          lookupSourceMapping:
            binding.lookupRange === null
              ? null
              : sourceMapping(
                  binding.lookupRange.offset,
                  binding.lookupRange.length,
                ),
        })),
      };
    }),
  };
}
