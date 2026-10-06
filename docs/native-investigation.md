# Native UI and dispatch investigation

REA joins static resources, native metadata and code facts while keeping runtime
observations separate. Every result reports its evidence, target identity,
coverage and unknowns. The CLI and MCP use the same application workflows.

## Static inspection

- `inspect_asset_catalog` / `rea inspect-asset-catalog <app>` reads compiled
  `Assets.car` metadata through macOS `assetutil --info`. Catalog digests, raw
  rendition fields, pagination and exact UI resource-name matches are returned.
  Image extraction and undocumented rendition interpretation are unsupported.
- `inspect_keyed_archive` / `rea inspect-keyed-archive <plist>` reads XML or
  binary Foundation keyed archives without instantiating classes. For an active
  app, provide its relative archive path as the second CLI argument or MCP
  `path`. Results retain original `$objects` indices, named `$top` roots,
  shared/cyclic references, class descriptors, raw serialized fields and
  malformed/unresolved/nil references. Missing fields stay absent; unknown
  classes are preserved. Select `root`, `offset` and `limit` explicitly.
  UID 0 cannot distinguish conditional nil from ordinary nil. Limits are
  64 MiB of input, 200,000 objects/references and 128 nesting levels.
- `decode_interface_builder` / `rea decode-interface-builder <app>` reads
  compiled storyboard and nib resources into objects, outlets, actions,
  connections and controller/class names. `verify:interface-builder` compiles
  a source-owned AppKit XIB with `ibtool`. Storyboards require an installed
  iOS platform; unsupported archive forms remain explicit.
- `inspect_native_dispatch_metadata` / `rea inspect-native-dispatch-metadata
  <app-or-binary>` prefers a validated macOS Mach-O byte reader. It decodes
  64-bit little-endian Objective-C class/metaclass records, superclass pointers,
  absolute/relative method entries, ivar offsets/sizes/alignment and protocol
  declarations. It also decodes simple Swift conformances, static synchronous
  witness slots, signed-relative pointers and non-generic, non-resilient class
  vtable descriptors. Records include exact virtual addresses/file offsets and
  artifact evidence. Vtable indexes are metadata word offsets; witness indexes
  start after the conformance header. Names unavailable in metadata remain null.
  Chained fixups, external bindings, authenticated pointers, categories,
  properties, generic/resilient/async/coroutine tables and inherited overrides
  have explicit unsupported or partial coverage. Other providers retain the
  existing symbol-based inventory with its narrower coverage.

## Native instruction, call and type primitives

Ghidra supplies three exact-object operations:

```bash
rea inspect-native-instruction <binary> <address> --provider ghidra
rea resolve-native-call-targets <binary> <call-site> --provider ghidra
rea inspect-native-data-type <binary> --type /MyStruct --provider ghidra
rea inspect-native-data-type <binary> --address <typed-data-address> --provider ghidra
```

Instruction facts include bytes, length, decoder text, ordered register/scalar/
address tokens, typed references and flow destinations. Mid-instruction, data,
outside-memory and undecodable addresses have separate outcomes. Effective
memory base/index/displacement roles and per-instruction context mode remain
unavailable; `mode` is the program language variant.

Call resolution reports direct, resolved indirect, ambiguous, unresolved and
non-call outcomes from static call references. It does not establish runtime
execution or classify Objective-C/Swift/vtable/closure mechanisms from names.

Type inspection selects one exact database pathname or typed data address.
Struct/union fields, enums, pointers, arrays, typedefs, size, alignment, packing
and bitfields retain database authority. Child types use exact IDs for further
inspection, including recursive layouts. Source/debug authority and flexible
array semantics are not inferred. The real lane uses a native DWARF 4 object
with a struct containing a union, enum and recursive pointer; a stripped linked
binary may have no corresponding recovered layout.

## Bounded static traces

`trace_native_ui_action` / `rea trace-native-ui-action <target> <seed>` accepts
one authored selector/object ID, native symbol or exact function address. It
joins UI wiring to uniquely matched class/selector implementations and follows
bounded typed call references. Direct references, resolved indirect references,
ambiguous candidates, inferred untyped provider callees and targetless call
sites remain distinct. A static route does not establish runtime reachability.
Swift/closure dispatch requires resolved static references; unavailable ABI
forms remain unknown.

`trace_native_values` / `rea trace-native-values <binary> <procedure> --provider
 ghidra` composes high-p-code def-use graphs across statically resolved calls.
Logical CALL arguments bind to recovered parameter ordinals; recovered RETURN
values bind to CALL outputs. These edges are decompiler-derived. Constants,
operators, LOAD/STORE and branch operands are included inline. Alias effects,
persistent state, RNG roles, missing/variadic bindings and ambiguous destinations
remain unknown. Budgets control depth, decompilations, call-site resolutions,
nodes and edges. Node payloads are bounded to 8 MiB and serialized results to
32 MiB. Pagination returns edges whose source is on the node page and preserves
stable IDs for endpoints outside that page.

The raw Java `is_dead` flag can remain set after Ghidra decodes a live block;
`block_membership` reports actual syntax-tree membership separately.

The provider dossier itself retains up to 3,000 p-code operations, 64 inputs per
operation and 12,000 def-use edges, with explicit omitted counts. A `STORE`
may describe stack memory and does not itself prove persistent state.

Jump-table evidence keeps numeric `mappings`, explicit `default_targets`, and
backing `data_sources` separate. A null case value denotes an unresolved
case, never a known default. Ghidra pairs typed case/default tokens with the
recovered block entry and its unique indirect dispatch predecessor; it does
not zip unequal label and destination arrays. Shared case bodies retain each
label. Negative numeric tokens are checked against their encoded magnitude;
nonliteral, ambiguous, or nonexact JSON integer labels remain unknown.
Unknown-label diagnostics retain the token text, encoded unsigned magnitude,
target and dispatch so callers can inspect the original observations.
Decompiler load-table metadata supplies observed entry sizes and counts
without assigning every backing table to each mapping. These observations
describe the decompiler's recovered switch, not guaranteed original source.
Legacy records without `default_targets` normalize to an empty array and
retain their existing unresolved mappings.

AArch64 jump-table recovery additionally verifies byte and halfword relative
forms from unsigned bounds, register definitions, table loads, branch bases,
scaled ADD/BR instructions and the recovered target set. It reads exactly the
proven count and preserves unknowns for other forms. Real ELF and host ARM64
Mach-O fixtures check each case against source-owned return values.

## Native desktop observation

`observe_native_ui` captures one explicitly selected existing PID/window ID.
Screenshots use a selected-window ScreenCaptureKit
filter on macOS 14+; accessibility reads stay within that window. Missing Screen
Recording/Accessibility permissions produce actionable errors without broad
capture or automatic permission prompts. Executable bytes and process launch
time guard against a different target or PID reuse. AX selection requires one
unique geometry match; ambiguity fails closed.

`capture_native_ui_scenario` takes AX child-index paths for press, increment/
decrement scrolling and text-value entry, or bounded waits. No global event
injection is used. Unsupported AX actions fail explicitly. The result preserves
ordered before/after captures and gaps; an action may have occurred before a
post-action capture fails. Application state is left as-is; REA does not attempt
to restore it.

Scenarios accept caller-selected action lists and accessibility node counts.
Individual waits cannot exceed the operation's 180-second deadline, and the
complete scenario result has a 64 MiB output budget. Screenshots are scaled to
at most 2,048 pixels and captured only for the selected window. REA compiles one
owned helper per scenario, removes its temporary compiler cache and stops its
helper on cancellation. It does not launch or own the selected application. UI
actions may change application data or trigger network activity.

## Provider and verification boundaries

Install Ghidra 12.1.4 and a full 64-bit JDK 21 separately, then configure REA to
use them. Ghidra analysis supports Linux x64 and macOS x64/arm64; macOS requires
the matching native decompiler. Experimental Windows x64 P0 admits native
x86-64 PE applications on local NTFS using bundled Job Object ownership,
protected runtime DACLs, and handle-based path admission. See [Windows Ghidra P0](windows-ghidra-p0.md) and
[issue #527](https://github.com/morluto/rea/issues/527).
Ghidra has no GUI or mutation authority, and REA never falls back automatically
to Hopper.

- `npm run verify:ghidra`: host-native debug/stripped targets, native type layout,
  instruction/call facts, value dependencies and process/project cleanup.
- `npm run verify:ghidra:aarch64-jump-table`: optimized ELF and byte/halfword
  relative tables, plus ARM64 Mach-O on an ARM64 macOS host.
- `npm run verify:apple-dispatch`: source-built Objective-C protocols/classes and
  Swift conformances/vtables, repeated after stripping local symbols.
- `npm run verify:native-ui`: one source-owned fixture window, successful
  selected-window capture and actions, changed-target rejection, and cleanup.
  Missing OS permissions fail this lane.
- `npm run verify:native-ui:permissions`: permits a permission-denial result and
  reports `positive_e2e: false` when capture is denied. That result verifies the
  OS permission boundary, not successful UI capture or actions.

macOS ARM64 is the real host verified during this implementation. Admission of
macOS Intel does not claim an Intel verification run. Unsupported metadata and
unresolved runtime/value semantics remain visible in results.
