# Provider-neutral V-CPU interpreter structure analysis (#5820)

Status: proposal — blocked pending the maintainer scope decision in
<https://github.com/morluto/rea/issues/5820>.

## Outcome

Add a read-only, provider-neutral structural dossier for native code regions
that analysts identify as a custom bytecode interpreter. The dossier reports
the observed and inferred structure of the interpreter's fetch, decode, and
dispatch path, including:

- the candidate dispatch loop and the instructions that support that
  classification;
- direct and recovered indirect dispatch targets;
- the handler table's entry addresses, widths, and data sources;
- the register, stack, and memory operands involved in the dispatch path;
- the references from handler entries back into the active native analysis
  session;
- explicit unknowns for unresolved targets, opaque predicates, aliases, and
  handler regions that cannot be statically resolved.

The result is evidence, not a deobfuscated program. It does not decode custom
bytecode semantics, reconstruct original source, or claim to recover protected
code.

## Scope

This workflow is limited to:

- caller-selected native analysis sessions and caller-identified code/data
  regions;
- read-only inspection of already retained provider evidence;
- static relationships that can be represented as typed native-analysis
  facts;
- reporting complete, partial, or unknown coverage separately for each
  admitted evidence source.

It is not:

- automatic bytecode decoding;
- automatic devirtualization;
- a bundled decompiler plugin that claims generic VMP recovery;
- target execution, attach, injection, or memory/register mutation;
- anti-debugging or anti-instrumentation evasion;
- a workflow to defeat commercial packing or code-virtualization protections.

## Contract

The input is:

- `session_id`: the active native analysis session;
- `dispatch_region`: the selected function or basic-block range;
- `handler_table_region`: the selected data region or table address range;
- optional `entry_count`, `entry_width`, and `entry_encoding` when the caller
  already knows the table's shape.

The output is a typed graph with:

- `dispatch_loop` nodes, each carrying the instruction addresses and the
  supporting evidence;
- `dispatch_targets` edges, each carrying the source table entry, the target
  address, and a `resolved`, `unresolved`, or `inferred` status;
- `handler_entry` nodes, each linked to its backing data source and, when
  available, the provider's recovered function or symbol;
- `state_operand` nodes for the register, stack, and memory operands observed
  in the dispatch path;
- `coverage` per evidence source and overall, distinguishing `complete`,
  `partial`, and `unknown`.

## Authority

The workflow consumes existing authenticated native-analysis Evidence from
Hopper, Ghidra, or IDA. It does not start a provider, execute target code, or
modify provider state. Any provider that cannot supply a required fact reports
that fact as unknown rather than inventing it.

## Resource admission

The dossier must be built from bounded, already retained provider facts. It
must not introduce an unbounded traversal of the active program. The
projection should:

- admit the selected regions before constructing the graph;
- preserve pagination and truncation from the underlying provider evidence;
- report the exact number of omitted dispatch targets or handler entries;
- keep the serialized dossier within the existing native-analysis output
  budget.

## Verification

Verification requires a self-owned synthetic native fixture with:

- an explicit dispatch loop;
- a table of handler entries;
- a second fixture with computed or partially opaque targets.

The first fixture must produce a complete dossier. The second must remain
partial and explicitly report unresolved targets rather than guessing.
Additional coverage should include:

- provider refusal when the selected regions are not admitted;
- cancellation before and during projection;
- CLI and MCP parity;
- complete/partial/unknown coverage reporting;
- no target execution or mutation.

## Open questions

1. Should the first implementation be a projection over retained Ghidra
   evidence only, before Hopper and IDA are considered?
2. Which provider-neutral instruction and reference facts are sufficient for
   the initial dossier?
3. Should `entry_count`, `entry_width`, and `entry_encoding` be required, or
   inferred only when the provider already recovered them?
4. Should the workflow be exposed as a dedicated tool or composed from a
   smaller set of native-analysis primitives?
