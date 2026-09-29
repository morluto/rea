# Native UI and dispatch investigation

REA combines decoded application resources, provider metadata, and native code
analysis into evidence-linked investigation graphs. Each layer has a different
coverage boundary; a graph edge is not automatically proof that a runtime path
executes.

## Current workflow

1. `decode_interface_builder` reads compiled Apple storyboard and nib resources
   from an artifact graph and returns scenes, objects, outlets, actions,
   connections, and available controller/class names. It records unsupported
   archive objects and partial coverage instead of treating them as absent.
2. `inspect_native_dispatch_metadata` normalizes supported provider name
   inventory into typed Objective-C and Swift records. Current extraction is
   symbol-name based: symbolized Objective-C method implementations and
   mangled Swift names can be reported as partial evidence. It does not yet
   decode Objective-C runtime sections, ivar layouts, protocol conformance
   records, Swift witness tables, vtables, relative pointers, or closure
   thunks from binary metadata.
3. `trace_native_investigation` walks a supplied bounded graph and can join an
   Interface Builder action to a unique symbolized Objective-C selector
   implementation. Ambiguous and missing implementations remain unresolved.
   The caller-provided graph is not automatically populated by a whole-program
   native call-graph or runtime traversal.
4. Ghidra `analyze_function` returns a bounded high-p-code def-use view for the
   selected function. This can support manual state/value analysis, but REA
   does not yet compose those views into an automatic cross-function slice.

## Ghidra p-code result boundary

The dossier retains up to 3,000 p-code operations, up to 64 inputs per
operation, and 12,000 def-use edges. Each operation carries its address,
sequence, opcode, input/output varnodes, and whether Ghidra marks it dead.
Memory reads/writes, conditional and indirect branches, and direct/indirect
calls are reported by opcode with operand indexes. Results expose truncation,
an omitted-operation lower bound, and known omitted-input and omitted-edge
counts.

These are decompiler-derived static observations. Def-use edges stop at a
function boundary; memory aliasing, call side effects, unresolved dispatch,
runtime behavior, and application-level meaning require additional evidence.
A p-code `STORE` can describe stack memory and does not by itself identify
persistent application state.

Recovered jump-table load sources and case-to-target mappings are reported as
separate facts. On AArch64, REA additionally decodes the verified byte-indexed
relative branch-table form when the selector's unsigned upper bound, `LDRB`
table load, `ADR` branch base, scaled `ADD`, indirect `BR`, and recovered
target set agree. It reads only the proven entry count and reports one direct
mapping per selector value. Other layouts retain unknown case values and
unknown table bounds when Ghidra does not provide aligned labels or load-table
metadata; REA does not extrapolate from neighboring targets.

## Provider admission and remaining work

The macOS Ghidra host path has installation checks for Intel and Apple Silicon,
including a matching native decompiler binary. It passed real host acceptance
with Ghidra 12.1.4 and a full JDK 21 on Apple Silicon. The optimized AArch64
ELF byte-table fixture has a separate lane so its acceptance does not depend on
PE or Mach-O cross-linkers.

The broader native metadata and trace goals still require provider-backed
runtime metadata readers, dispatch-table and closure/thunk recovery, automatic
bounded graph construction across functions, and source-owned fixtures for
field reads/writes, predicates, RNG ranges, and multiple state mutations.
Until those are implemented and verified, the relevant feature issues remain
partially complete rather than closeable.
