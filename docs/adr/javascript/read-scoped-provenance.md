# Scope backward JavaScript provenance to the selected read

## Status

Proposed, 2026-11. See [the design discussion](https://github.com/morluto/rea/issues/12581)
and [the earlier destructuring fix](https://github.com/morluto/rea/pull/7716).

## Context

A backward query from a captured binding can include a write made after the
capture. This was reproduced on main at `8bb01b514` with the compiled CLI,
Node.js 24.22.1, and Ubuntu 24.04 WSL2. The analyzer read one authored source file
per application and did not run the fixture code.

```js
const config = { mode: "strict" };
const { mode } = config;
config.mode = "loose";
```

Run `analyze-javascript-application <directory> --json` and save the returned
application Evidence. Pass it as `application` in a
`trace-javascript-semantics` request. Use a `semantic-node` seed for the `mode`
binding and `backward-provenance` for the direction. Repeat with the
`property-slot` node as the seed in both `backward-provenance` and
`forward-influence`. Leave candidate-edge handling at the default.

| Fixture change                                                      | Backward from binding          | Backward from slot | Forward from slot  |
| ------------------------------------------------------------------- | ------------------------------ | ------------------ | ------------------ |
| Assign `mode` after the capture                                     | `ambiguous`, 5 nodes / 4 edges | `ambiguous`, 2 / 1 | `found`, 2 / 1     |
| Omit the assignment                                                 | `found`, 7 / 6                 | `found`, 4 / 3     | `found`, 2 / 1     |
| Assign `other` after the capture                                    | `found`, 7 / 6                 | `found`, 4 / 3     | `found`, 2 / 1     |
| Move the `mode` assignment before the capture                       | `ambiguous`, 2 / 1             | `ambiguous`, 2 / 1 | `ambiguous`, 1 / 0 |
| Pass a `mode`-writing closure to an unknown call before the capture | `ambiguous`, 2 / 1             | `ambiguous`, 2 / 1 | `ambiguous`, 1 / 0 |

The first trace includes a resolved `destructures` edge, the captured literal
`"strict"`, and the later `write:/mode` occurrence. The slot also has a
candidate initializer edge. The analysis already proves that the property
was present at the read. The graph's shared slot holds both the capture
relationship and write history. The backward traversal reverses those edges,
and its candidate assessment also uses the reached slot's incoming edges.
Consequently, a known capture inherits the slot's broader history and ambiguity.

## Decision

Ask maintainers to approve the following default. A backward trace through a
proved read should include only value sources that the analyzer can relate to
that read. An explicit slot query retains its broader history, and existing
forward influence remains available.

- Have the semantic engine own the relation between the selected occurrence,
  the property path, and reaching writes. Its current read-site presence fact
  establishes presence. A reaching-write fact needs separate proof.
- Project that proof with the read edge or with an occurrence tied to that edge.
  Keep the existing slot identity and history. Evaluate candidate and unknown
  frontiers with the same read scope used for traversal.
- Retain a candidate or unknown when the analyzer lacks ordering, alias,
  control-flow, or deferred-effect proof. Source offsets alone do not settle
  these questions. A matching literal alone does not identify its producer.
- Keep existing serialized Evidence readable. When it lacks the new proof,
  retain its conservative result and record the coverage limitation if one is
  needed. Any stronger fact requires a new analysis of the source.

## Consequences

Verify fresh and retained application Evidence through the CLI and MCP. The
after-read fixture should retain the captured value and resolved destructuring
while excluding the later write as a source of that read. The no-write and
unrelated-write controls should retain their resolved behavior. Include a
before-read write where the producer can establish the reaching definition and
a deferred write whose order remains unknown. Compare explicit slot and forward
results as controls. Verify that old serialized Evidence still parses and
retains its identity and uncertainty.

This proposal changes no tool parameters. The shape, evidence representation,
and limits for any added per-read facts need review before implementation.
