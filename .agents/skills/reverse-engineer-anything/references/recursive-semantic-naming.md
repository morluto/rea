# Recursive semantic naming

Use this workflow when the requested result includes readable names for
obfuscated or decompiled functions, variables, fields, parameters, or constants.
Recover names from behavior and propagate supported meanings from callees to
callers. An inferred name is an analyst interpretation, not recovery of the
original identifier or proof that decompiled source matches the shipped program.

This guide uses existing static Evidence and ordinary language-aware editing
tools. It adds no REA rename operation or automatic target mutation. Keep the
supplied artifact unchanged; apply requested edits in a separate derived tree,
or return a name map when an editable representation is unavailable. Target
execution and provider-database changes remain separate workflows with their
existing scope and authority requirements.

## Establish identity and dependencies

Retain the artifact digest, provider and analysis profile, source/decompiler
version, and references needed to interpret each declaration. Reuse matching
retained Evidence instead of decompiling the whole program again for naming.
Use the connected tools' actual schemas and the relevant target guide to obtain
selected bodies, callers, callees, and value uses. An unavailable relationship
query or unresolved indirect call leaves an explicit gap in the graph.

Give each symbol a stable identity independent of its proposed name:

- Native code: artifact identity, architecture, procedure address and provider
  context; preserve same-address aliases and shared bodies.
- Managed code: assembly identity, declaring type, metadata token when available,
  and full signature, including generic arity and overload parameters.
- Decompiled or JavaScript source: artifact/module identity, lexical scope and
  declaration location; a spelling alone does not identify shadowed bindings.

Inventory the declarations within the requested boundary and their known call
or dependency edges. Keep external dependencies, dynamic dispatch, reflection,
and unresolved aliases visible. Use returned graph identities or language-aware
analysis; textual name matches alone cannot establish binding.

## Name from leaves to callers

1. Orient each edge from a caller to its callee. Collapse strongly connected
   components (SCCs): mutually recursive functions form one component, and a
   self-call is recursive even when its component has only one member.
2. Process the condensed graph callee-first: start with known leaves, then visit
   a component once its known callee components have been visited. Treat missing
   graph edges as unknown, not as proof that a component is a leaf. Give each
   scheduled component an explicit ID and retain dependency IDs alongside member
   IDs; carry unresolved calls into its interpretation.
3. For a leaf, inspect operations, input/output types, value uses, state changes,
   and established library or protocol contracts. Name functions for an action
   and object, values for their role, and constants for meaning and units when
   supported. For a cycle, infer the members' roles together before propagating
   those names outside the component.
4. Update the reviewed name map and revisit callers whose interpretation depends
   on the newly understood results. Propagate via resolved bindings, including
   captured variables and named arguments where the language requires it.
5. Stop when a pass adds no evidence-supported names or confidence improvements.
   Keep uncertain symbols in an unresolved queue. Repeating the same inference
   or making a name more specific is not additional evidence.

For example, in a synthetic graph `a -> b -> c`, operations in `c` might justify
`readLittleEndianUInt32`. If `b` uses that result as an allocation length and
checks the remaining input, `readLengthPrefixedPayload` may be supported.
That does not by itself justify calling `a` a login or license handler.
For `b -> c -> b`, review both functions as one component rather than trying to
find a leaf inside the cycle.

Use a conservative role name such as `payloadLength` when established. If only
storage identity is known, a name such as `cachedStringSlot12` may help navigation
but must be labeled structural, not semantic recovery. Do not invent domain
meaning to meet a goal of naming every symbol.

## Record and apply reviewed names

For each proposal, record the stable symbol ID, original spelling, proposed
name, scope/signature, supporting Evidence IDs or exact source locations,
confidence and rationale. Separate observed metadata names from inferred names
and structural fallbacks. Retain conflicting evidence and rejected proposals.
Store this map with the investigation, not in this reusable skill bundle.

Use a compiler semantic model, language server, or an equivalent binding-aware
editor for source changes. Check collisions, overloads, generic parameters,
constructors, operators, lambdas, captures, and shadowing. Keep declarations and
their references bound to the same identity after editing; a successful parse
does not establish that name resolution stayed unchanged.

Treat exported APIs, interface and override members, serialization/ORM names,
FFI entrypoints, reflection strings, and resource keys as contracts. Keep their
spellings unless the requested compatibility change includes the affected
consumers. In managed metadata, preserve `.ctor` and `.cctor`; in derived source,
use the language's constructor syntax and binding rules. Compiler checks do not
validate reflection: update only references whose owner, signature and lookup
behavior are established, and leave unresolved lookups unchanged.

Name existing constant declarations by their verified role. Extracting literals
into new constants is a separate transformation requiring equivalence checks.
For string-pool entries, retain cache slot plus slice offset and length where
those establish identity; offset alone can merge distinct empty slices. String
contents alone do not establish the behavior of their consumer. Runtime decoding
is not required merely to make an identifier readable.

## Validate and deliver

Preserve an inverse edit map or patch and verify it reconstructs the original
derived files byte for byte, including encoding and comments. Separately check
changed syntax, resolved reference identities and collisions, then compile the
changed modules with their actual references when available. State missing
dependencies and compilation warnings. Reversibility proves edit provenance;
compilation alone does not establish runtime or reflection equivalence.

Use focused behavior checks only when the change and available authorized
environment warrant them. A static naming task does not require launching the
target. Report checks actually run separately from proposed runtime verification.
For native/AOT pseudocode, readable analyst names do not recover original source,
local variables, or a buildable project.

Deliver the derived output or name map, supporting evidence, dependency order,
inverse changes, validation results, and unresolved symbols/contracts. Report
coverage against the inventoried boundary: distinguish semantically named,
structurally labeled, preserved contractual, and unresolved declarations. A
count of replacements does not prove complete program understanding.

Workflow contributed by [Hossein Mirhadi (@MiRHaDi)](https://github.com/MiRHaDi).
