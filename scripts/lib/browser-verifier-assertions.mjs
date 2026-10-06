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

/** Assert passive real-browser inventory, event, privacy, and metadata claims. */
export function assertObservation(result, origin) {
  assertObservationInventory(result, origin);
  assertObservationEvents(result);
  assertObservationPrivacy(result);
  assertObservationMetadata(result);
}

function assertObservationInventory(result, origin) {
  if (result.target.origin !== origin)
    throw new Error("Real Chrome target origin was not preserved exactly");
  if (result.frames.length < 1 || result.dom.nodes.length < 1)
    throw new Error(
      `Real Chrome DOM/frame observation was empty: ${JSON.stringify({ frames: result.frames.length, domTotal: result.dom.total_nodes, domReturned: result.dom.nodes.length, limitations: result.limitations })}`,
    );
  if (result.accessibility.nodes.length < 1)
    throw new Error("Real Chrome accessibility observation was empty");
  if (
    result.accessibility.text_capture.status !== "not_approved" ||
    result.accessibility.nodes.some(
      (node) => node.name !== null || node.description !== null,
    )
  )
    throw new Error("Accessibility text was retained without approval");
  if (!result.scripts.items.some((script) => script.url.includes("/app.js")))
    throw new Error("Real Chrome script metadata was missing");
  if (!result.resources.some((resource) => resource.url.includes("/app.js")))
    throw new Error("Real Chrome resource metadata was missing");
}

function assertObservationEvents(result) {
  if (!result.network.requests.some((request) => request.url.includes("/api")))
    throw new Error(
      "Real Chrome attach-window network observation was missing",
    );
  const initiatedRequest = result.network.requests.find((request) =>
    request.url.includes("/api"),
  );
  if (
    !initiatedRequest?.initiator.url?.includes("/app.js") ||
    initiatedRequest.initiator.line === null ||
    initiatedRequest.initiator.column === null
  )
    throw new Error("Real Chrome script initiator stack was not normalized");
  if (result.console.events.length < 1)
    throw new Error(
      "Real Chrome attach-window console observation was missing",
    );
  if (result.network.websocket_events.length < 1)
    throw new Error("Real Chrome WebSocket metadata was missing");
}

function assertObservationPrivacy(result) {
  if (
    result.console.events.some(
      (event) => event.text_capture.status !== "not_approved",
    ) ||
    result.network.requests.some(
      (request) => request.body_shapes.status !== "not_approved",
    ) ||
    result.network.websocket_events.some(
      (event) => event.payload_shape !== null,
    )
  )
    throw new Error(
      "Sensitive text or payload shapes were retained without approval",
    );
}

function assertObservationMetadata(result) {
  if (!result.storage.local_storage_keys.includes("rea-storage-key"))
    throw new Error("Real Chrome local-storage key inventory was missing");
  if (
    result.storage.content_fingerprints.filter(
      ({ scope }) => scope === "cookie",
    ).length !== 2
  )
    throw new Error(
      "Real Chrome root and current-page cookie fingerprints were missing",
    );
  if (!result.storage.indexed_db_names.includes("rea-browser-db"))
    throw new Error("Real Chrome IndexedDB name inventory was missing");
  if (!result.storage.cache_names.includes("rea-browser-cache"))
    throw new Error("Real Chrome cache name inventory was missing");
  if (
    !result.metadata.responses.some(({ csp }) =>
      csp.directives.some(({ name }) => name === "default-src"),
    ) ||
    !result.metadata.agent_hints.some(
      ({ declaration }) => declaration === "service-desc",
    )
  )
    throw new Error("Real Chrome safe response metadata was missing");
}

/** Assert real-browser static bundle and source-map findings. */
export function assertBundleAnalysis(result) {
  if (
    result.capture.scripts_analyzed < 1 ||
    !result.observations.routes.some(({ value }) =>
      value.includes("/verified-route"),
    ) ||
    !result.observations.endpoints.some(({ value }) => value.includes("/api"))
  )
    throw new Error("Real Chrome static bundle findings were missing");
  if (
    result.observations.source_maps.status !== "included" ||
    !result.observations.source_maps.items.some(
      ({ status, original_sources, original_module_edges, mappings }) =>
        status === "included" &&
        original_sources.some(({ source }) =>
          source.includes("/src/main.ts"),
        ) &&
        original_module_edges.some(
          ({ specifier }) => specifier === "./dependency.ts",
        ) &&
        mappings.length > 0,
    )
  )
    throw new Error(
      `Real Chrome approved source-map reconstruction was missing: ${JSON.stringify(sourceMapSummary(result.observations.source_maps))}`,
    );
}

/** Assert explicitly selected console text and JSON/WebSocket shape capture. */
export function assertSensitiveShapes(result) {
  const request = result.network.requests.find(
    (item) =>
      item.url.includes("/api") &&
      item.body_shapes.request?.properties.some(
        ({ path }) => path === "/token",
      ) &&
      item.body_shapes.response?.properties.some(
        ({ path }) => path === "/secret",
      ),
  );
  if (request === undefined)
    throw new Error("Real Chrome JSON request/response shapes were missing");
  const consoleText = result.console.events.flatMap(
    (event) => event.text_capture.values,
  );
  if (
    !consoleText.some(({ text }) =>
      text.includes("authorization=Bearer console-secret-value"),
    )
  )
    throw new Error("Real Chrome selected console text was not preserved");
  if (
    !result.network.websocket_events.some(
      (event) =>
        event.payload_shape?.format === "json" &&
        event.payload_shape.json_shape?.properties.some(
          ({ path }) => path === "/token",
        ),
    )
  )
    throw new Error("Real Chrome WebSocket JSON shape was missing");
  const serialized = JSON.stringify({
    console: result.console,
    network: result.network,
  });
  for (const secret of [
    "request-body-secret-value",
    "response-secret-value",
    "request-secret-value",
    "websocket-secret-value",
  ])
    if (serialized.includes(secret))
      throw new Error(`Approved shape capture retained raw value: ${secret}`);
}
