# MCP tool design

Design tools around analyst tasks. A provider API is an implementation detail;
expose it directly only when users need a bounded, reusable primitive that
cannot be expressed through an existing contract.

## Choose the tool shape

| Shape | Use it for | Contract should return |
| --- | --- | --- |
| `inspect` | Facts about one explicit target, address, object, or resource | Bounded fields, source locations, and facet-level availability |
| `search` / `list` | Finding candidate targets or entities | Stable ordering, filters, pagination, and exact totals or an explicit unknown |
| `trace` | Relationships across code, metadata, UI resources, or observations | Typed edges, evidence per edge, traversal limits, and unresolved paths |
| `compare` | Two explicitly identified artifacts, versions, or evidence sets | Paired identity, comparable coverage, and deltas with evidence |
| `workflow` | A repeated analyst question that otherwise requires a fragile call sequence | The composed result, contributing evidence, and partial/unavailable facets |
| `observe` / `capture` / `replay` | A question that requires runtime behavior | Required authority, launch/attach behavior, bounds, lifecycle, and cleanup status |

These are task shapes, not required prefixes. Name a tool for the action and
object agents reason about; keep the name distinct from nearby alternatives.

## Decide whether to add a tool

1. State the user intent and the smallest result that answers it.
2. Inspect the canonical tool contracts, current provider capabilities, and
   representative CLI/MCP traces. Record the nearest competing tool.
3. Extend an existing contract when the intent and result are the same. Add a
   bounded batch when agents repeat scalar calls over a coherent set. Add a
   workflow when agents repeatedly compose the same stages. Add a new tool when
   it answers a distinct analyst question or has a materially different
   authority or result contract.
4. Keep public tool names and result semantics provider-neutral. Put engine-
   specific parsing and protocol handling in adapters. Advertise exact support
   per provider; do not create parallel tools just because engines differ.
5. Keep prompts instructional. A prompt can suggest a sequence, but it does not
   replace a tool that must perform bounded work or return durable evidence.

Avoid scalar-tool sprawl, model-authored N+1 loops, opaque mode flags, and
mega-tools that combine unrelated discovery, execution, and mutation.

## Define the contract

- Use strict object inputs with explicit required fields, enums, and bounds.
- Make pagination, truncation, partial failure, cancellation, and expected
  unavailable states explicit. Missing evidence is unknown, not empty or false.
- Return task-oriented results with artifact identity, provider/version,
  addresses or resource paths, Evidence IDs, confidence, and limitations when
  they affect the conclusion.
- Separate observed facts from derived and inferred edges. Cite the evidence
  supporting every important relationship; preserve unresolved edges.
- Declare read-only, mutation, process, filesystem, network, and UI effects
  truthfully in the contract and permission boundary.
- Keep provider-specific types out of provider-neutral domain and application
  layers. Normalize supported provider results without implying equal coverage.

## Implement and evaluate

- Put shared user workflows in the application layer; keep MCP translation in
  the server adapter and CLI behavior aligned with the same workflow.
- Update the canonical contract inventory, output schemas, examples, generated
  catalog, and relevant docs together.
- Verify valid, malformed, boundary, unavailable, cancellation, and partial
  results at the owning boundaries. Use real-provider checks for claims that
  depend on external analysis engines.
- Evaluate representative broad and direct task prompts on the intended MCP
  host when tool selection is the question. Record the host, model-facing tool
  catalog, selected tool, arguments, errors, retries, and task outcome.
  Schema validity or word-overlap heuristics do not prove discoverability.

See [mcp-contracts.md](mcp-contracts.md) for shipped runtime behavior and
[testing.md](testing.md) for test boundaries and verification lanes.
