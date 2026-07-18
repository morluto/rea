export function sourceMapSummary(sourceMaps) {
  return {
    status: sourceMaps.status,
    requested: sourceMaps.requested,
    processed: sourceMaps.processed,
    dropped: sourceMaps.dropped,
    items: sourceMaps.items.map((item) => ({
      status: item.status,
      declaredUrl: item.declared_url,
      sources: item.original_sources.map(({ source }) => source),
      edgeSpecifiers: item.original_module_edges.map(({ specifier }) =>
        specifier.slice(0, 256),
      ),
      mappings: item.mappings.length,
      limitation: item.limitation,
    })),
  };
}
