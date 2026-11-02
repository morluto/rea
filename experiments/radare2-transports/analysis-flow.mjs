// Experiment-only decompiler scope and native SSA dependency projection.
import { parseHighPcode } from "./high-pcode.mjs";

export function decodeHighPcode(xml, nativeFunction) {
  const parsed = parseHighPcode(xml);
  if (!parsed.ok) throw parsed.error;
  const flow = parsed.value;
  const at = nativeFunction.procedure.address;
  if (flow.procedure.address !== at)
    throw new Error("P-code function identity differs from selected entry");
  const withinNativeBody = (op) =>
    /^0x[0-9a-f]+$/iu.test(op.address) &&
    nativeFunction.basic_blocks.some(
      (block) =>
        BigInt(op.address) >= BigInt(block.start) &&
        BigInt(op.address) < BigInt(block.end),
    );
  const expanded = flow.operations
    .filter((op) => !withinNativeBody(op))
    .map((op) => op.address);
  flow.scope = {
    selected_function: at,
    native_body_external_operation_addresses: [...new Set(expanded)],
  };
  if (expanded.length)
    flow.limitations.push(
      "The decompiler expanded code outside the native function body (for example tail calls); those operation addresses remain explicit and are not native CFG members.",
    );
  return flow;
}

export function decodeEsil(nativeFunction) {
  return {
    producer: "radare2-native-analysis",
    ir: "esil",
    operations: nativeFunction.instructions.map(({ address, type, esil }) => ({
      address,
      type,
      esil,
    })),
    coverage: {
      decoded_instructions: nativeFunction.instructions.length,
      lifted_instructions: nativeFunction.instructions.filter((op) => op.esil)
        .length,
    },
    limitations: [
      "These are instruction lifts. No whole-function ESIL def-use, alias or call-binding proof is inferred from ESIL text.",
    ],
  };
}

export function traceFlow(flow, procedure, { parameter, max_nodes }) {
  const seeds =
    parameter === undefined
      ? flow.operations.map((op) => op.id)
      : flow.parameter_uses
          .filter((use) => use.ordinal === parameter)
          .map((use) => use.use);
  const selectedParameter = flow.parameters.find(
    (entry) => entry.ordinal === parameter,
  );
  const unknowns = [...flow.unknowns];
  if (
    parameter !== undefined &&
    (!selectedParameter ||
      selectedParameter.binding_basis === "unavailable" ||
      !seeds.length)
  )
    unknowns.push(
      "Selected parameter has no observed usable binding/uses; this does not establish that the source parameter is absent or unused.",
    );
  const reached = new Set();
  const pending = [...seeds];
  const outgoing = new Map();
  for (const edge of flow.def_use) {
    const targets = outgoing.get(edge.definition) ?? [];
    targets.push(edge.use);
    outgoing.set(edge.definition, targets);
  }
  while (pending.length && reached.size < max_nodes) {
    const id = pending.pop();
    if (reached.has(id)) continue;
    reached.add(id);
    pending.push(...(outgoing.get(id) ?? []));
  }
  const operations = flow.operations.filter((op) => reached.has(op.id));
  return {
    producer: flow.producer,
    ir: flow.ir,
    procedure: procedure,
    scope: flow.scope,
    source_coverage: {
      truncated: flow.truncated,
      omitted_operations_lower_bound: flow.omitted_operations_lower_bound,
      known_omitted_inputs: flow.known_omitted_inputs,
      known_omitted_edges: flow.known_omitted_edges,
    },
    parameter: parameter ?? null,
    parameters: flow.parameters,
    selection_status:
      parameter === undefined || seeds.length ? "observed" : "unknown",
    operations,
    def_use: flow.def_use.filter(
      (edge) => reached.has(edge.definition) && reached.has(edge.use),
    ),
    effects: flow.effects.filter((effect) => reached.has(effect.operation)),
    parameter_uses: flow.parameter_uses.filter((use) => reached.has(use.use)),
    truncated: flow.truncated || pending.some((id) => !reached.has(id)),
    unknowns,
    limitations: [
      ...flow.limitations,
      "Prototype trace is intraprocedural; call arguments are visible but interprocedural parameter/return bindings are not synthesized.",
      "A dependency is not a feasible path, alias-sensitive memory flow, taint proof or observed execution.",
    ],
  };
}
