# MCP tool design

Design tools around analyst tasks. A provider API is an implementation detail;
expose it directly when it gives agents a useful, reusable capability that
cannot be expressed through an existing contract. Do not impose caller-facing
limits merely to make work fit an assumed agent budget. Keep real input-format,
protocol, authority, and resource-safety constraints, and report their effects.

## Choose the tool shape

| Shape                            | Use it for                                                           | Contract should return                                                                                         |
| -------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `inspect`                        | Facts about one explicit target, address, object, or resource        | Relevant fields, source locations, and facet-level availability                                                |
| `search` / `list`                | Finding candidate targets or entities                                | Stable ordering and useful result context; expose pagination when the result format or caller's query needs it |
| `trace`                          | Relationships across code, metadata, UI resources, or observations   | Typed edges, supporting evidence, and unresolved paths; identify any genuine traversal boundary                |
| `compare`                        | Two explicitly identified artifacts, versions, or evidence sets      | Paired identity, comparable coverage, and deltas with evidence                                                 |
| `workflow`                       | A distinct analyst outcome that benefits from composition inside REA | A useful inline result, contributing evidence, and partial/unavailable facets                                  |
| `observe` / `capture` / `replay` | A question that requires runtime behavior                            | Required authority, launch/attach behavior, real operational constraints, lifecycle, and cleanup status        |

These are task shapes, not required prefixes. Name a tool for the action and
object agents reason about; keep the name distinct from nearby alternatives.

## Prefer primitives; compose workflows

Start with a primitive when one call can report a reusable fact about one
identified object or relationship, such as an instruction decode, a type
layout, a reference, a dispatch target, or a resource graph. The same primitive
should be useful across different applications or analyst questions. A
format-specific decoder can still be a primitive when it describes a reusable
format rather than one application's product behavior.

Add a workflow when repeated analysis shows that callers need the same
multi-source result and REA can join the evidence without hiding important
choices or uncertainty. A useful check is whether the workflow remains
meaningful for different applications that share the relevant evidence types.
If its purpose depends on one application's business rules or product concepts,
keep that interpretation outside the general tool contract and expose the
underlying evidence through reusable primitives.

## Decide whether to add a tool

1. State the user intent and the smallest result that answers it.
2. Inspect the canonical tool contracts, current provider capabilities, and
   representative CLI/MCP traces. Record the nearest competing tool.
3. Extend an existing contract when the intent and result are the same. Add a
   batch or composed workflow when it materially improves a demonstrated task;
   do not force agents through extra calls or collapse distinct tasks into one
   tool. Add a tool when it answers a distinct analyst question or has a
   materially different authority or result contract.
4. Keep public tool names and result semantics provider-neutral. Put engine-
   specific parsing and protocol handling in adapters. Advertise exact support
   per provider; do not create parallel tools just because engines differ.
5. Keep prompts optional and concise. They may point out useful tools, but must
   not prescribe a call sequence when the task can be answered directly.

Avoid opaque mode flags and mega-tools that combine unrelated discovery,
execution, and mutation. Prefer a useful direct tool call over a tool sequence
or model-authored loop when one call can answer the question.

## Define the contract

- Use strict object inputs with explicit required fields and enums. Add numeric
  bounds only when the format, protocol, authority, or a measured resource
  constraint requires them.
- Return complete results by default. Make real pagination, truncation, partial
  failure, cancellation, and unavailable states explicit. Missing evidence is
  unknown, not empty or false.
- Return task-oriented results inline with artifact identity, provider/version,
  addresses or resource paths, Evidence references, confidence, and relevant
  limitations. Do not require agents to fetch a resource or dereference an
  opaque Evidence link to understand a tool result.
- Separate observed facts from derived and inferred edges. Cite the evidence
  supporting every important relationship; preserve unresolved edges.
- Declare read-only, mutation, process, filesystem, network, and UI effects
  truthfully in the contract and enforce the target and lifecycle named in the
  request.
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
