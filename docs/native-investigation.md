# Native UI and dispatch investigation

REA combines decoded application resources, provider metadata, and native code
analysis into evidence-linked investigation graphs. Each layer has a different
coverage boundary; a graph edge is not automatically proof that a runtime path
executes.

## Current workflow

1. `decode_interface_builder` reads compiled Apple storyboard and nib resources
   from an artifact graph and returns scenes, objects, outlets, actions,
   connections, and available controller/class names. A source-owned AppKit
   XIB is compiled by `ibtool` in `verify:interface-builder` and checked for
   its hierarchy and target/action edge. Storyboard compilation still depends
   on an installed iOS platform; unsupported archive objects remain explicit.
2. `inspect_native_dispatch_metadata` normalizes supported provider name
   inventory into typed Objective-C and Swift records. Current extraction is
   symbol-name based: symbolized Objective-C method implementations and
   mangled Swift names can be reported as partial evidence. It does not yet
   decode Objective-C runtime sections, ivar layouts, protocol conformance
   records, Swift witness tables, vtables, relative pointers, or closure
   thunks from binary metadata.
3. `trace_native_ui_action` accepts one selector or Interface Builder object
   ID. REA decodes the active app and reads names from the bound native provider,
   verifies that both observations refer to the same target digest, joins an
   authored action to a symbolized Objective-C implementation, and follows
   bounded direct callees. Ambiguous selectors and unresolved calls remain
   explicit. This is a static candidate route, not proof of runtime reachability;
   it does not resolve Swift witnesses, vtables, closures, or cross-function
   value flow yet. The CLI uses the same query: `rea trace-native-ui-action
<app-or-binary> <selector-or-object-id>`.
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

The native feature set is still partial. Objective-C/Swift metadata currently
uses symbol names rather than runtime sections, witness tables, vtables, or
relative pointers. UI action traces do not yet resolve Swift dispatch or
closure/thunk routes. Value dependencies remain intra-function, and the
AArch64 switch lane currently proves one optimized byte-indexed ELF layout;
sparse, stripped, Mach-O, and other table patterns remain unknown. The local
Xcode installation has no iOS simulator platform, so compiled storyboard
acceptance could not run here. These boundaries should stay visible until
matching provider-backed readers and fixtures exist.
