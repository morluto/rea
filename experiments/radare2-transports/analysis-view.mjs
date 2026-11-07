// Pages consume the native boundary's parsed facts without rerunning the producer.
function select(result, facet) {
  if (facet === "raw") return JSON.stringify(result);
  const flow = result.high_pcode ?? result;
  return {
    cfg: result.basic_blocks,
    instructions: result.instructions,
    signature: result.signature,
    pseudocode: result.pseudocode,
    byte_hex: result.bytes_hex,
    flow_operations: flow.operations,
    flow_edges: flow.def_use,
    flow_parameters: flow.parameters,
    esil: result.esil?.operations,
  }[facet];
}

function coverage(result) {
  const source = result.high_pcode ?? result;
  // Preserve the owning representation's coverage; an IR name alone does not
  // make native ESIL instruction coverage into a high-pcode omission model.
  return Object.fromEntries(
    [
      "producer",
      "ir",
      "status",
      "complete",
      "coverage",
      "target_consistency",
      "selection_status",
      "truncated",
      "source_coverage",
      "omitted_operations_lower_bound",
      "known_omitted_inputs",
      "known_omitted_edges",
      "unknowns",
      "limitations",
    ]
      .filter((field) => Object.hasOwn(source, field))
      .map((field) => [field, source[field]]),
  );
}

export function viewObservation(
  experiment,
  { observation_id, facet, offset, limit },
) {
  const retained = experiment.view(
    observation_id,
    facet === "raw" ? "raw" : "result",
  );
  if (!retained.ok) return retained;
  const selected = select(retained.value, facet);
  const paged = Array.isArray(selected) || typeof selected === "string";
  const pageSize = typeof selected === "string" ? limit : Math.min(limit, 200);
  const total = paged ? selected.length : null;
  const target = experiment.view(observation_id, "target");
  const normalized =
    facet === "raw" ? experiment.view(observation_id, "result") : retained;
  if (!normalized.ok) return normalized;
  return {
    ok: true,
    value: {
      observation_id,
      facet,
      available: selected !== undefined && selected !== null,
      result: paged
        ? selected.slice(offset, offset + pageSize)
        : (selected ?? null),
      total,
      next_offset:
        paged && offset + pageSize < total ? offset + pageSize : null,
      unit: typeof selected === "string" ? "utf16-code-units" : "records",
      target: target.ok ? target.value : null,
      coverage: coverage(normalized.value),
    },
  };
}
