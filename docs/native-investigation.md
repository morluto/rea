# Native UI and dispatch investigation

REA joins static resources, native metadata and code facts while keeping runtime
observations separate. Every result reports its evidence, target identity,
coverage and unknowns. The CLI and MCP use the same application workflows.

## Static inspection

`inspect_macho` retains otool segment `file_offset` values relative to the
selected Mach-O slice. Its evidence file-offset ranges address the original
input file and include the observed lipo slice offset for universal binaries.
If that offset is unavailable, segment evidence locations are omitted with an
explicit limitation; architecture inventory locations remain available.

- `trace_dylib_resolution` / `rea trace-dylib-resolution <app-or-mach-o>`
  parses Mach-O load commands in TypeScript and follows dyld's path expansion
  for every executable in an app bundle, or for one Mach-O within its directory.
  It reports each `@rpath`, `@loader_path` and `@executable_path` candidate with
  its outcome. Paths outside the analyzed root, including shared-cache system
  libraries, stay undetermined. See
  [Apple application analysis](apple-application-analysis.md#dylib-load-resolution).
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
  XML plist archives accept UTF-8 and BOM-marked UTF-16 in either byte order.
  The shared keyed-archive and Interface Builder decoder consumes an initial
  BOM and rejects malformed byte sequences, unsupported encoding declarations,
  and declarations that disagree with the detected encoding. It never substitutes
  UTF-8 for a declared encoding it cannot process. Archive and evidence digests
  still identify the original serialized bytes.
- `inspect_native_dispatch_metadata` /
  `rea inspect-native-dispatch-metadata <app-or-binary>` prefers a validated macOS Mach-O byte reader. It decodes
  64-bit little-endian Objective-C class/metaclass records, superclass pointers,
  absolute/relative method entries, ivar offsets/sizes/alignment and protocol
  declarations. It also decodes simple Swift conformances, static synchronous
  witness slots, signed-relative pointers and non-generic, non-resilient class
  vtable descriptors. Records include exact virtual addresses/file offsets and
  artifact evidence. Vtable indexes are metadata word offsets; witness indexes
  start after the conformance header. Names unavailable in metadata remain null.
  Pointers are decoded through the image's fixups:
  - `LC_DYLD_CHAINED_FIXUPS` rebases and binds, including the authenticated
    arm64e formats;
  - legacy `LC_DYLD_INFO` bind opcodes.

  So an external superclass resolves from its `_OBJC_CLASS_$_` bind (for
  example `NSObject`). The `pointer_fixups` coverage facet names the mechanism.
  Class properties, with parsed attributes, and `__objc_catlist` categories are
  also decoded. Categories record the extended class, local or external, plus
  their methods, protocols and properties; category methods appear as
  implementations with a `category`. Swift field-offset globals that are only
  initialized at runtime stay unresolved. Generic, resilient, async and
  coroutine tables, and inherited overrides, have explicit unsupported or
  partial coverage. Other providers retain the
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

## Native call observation

`observe_native_calls` / `rea observe-native-calls <app-or-mach-o> <input-json>`
launches the active Mach-O as a new, owned process under LLDB. It stops at
caller-selected entries, records them and continues:

- functions by exact symbol name, optionally limited to one image;
- Objective-C methods by selector, optionally limited to one class and to
  instance or class methods.

```sh
rea observe-native-calls /Applications/Example.app '{"breakpoints":[{"kind":"objc-method","class_name":"NSURLSession","selector":"dataTaskWithRequest:completionHandler:"},{"kind":"function","name":"open","module":"libsystem_kernel.dylib"}],"duration_ms":5000,"backtrace_frames":4}' --json
```

Each event is an observation: thread, image, symbol, load and file address,
the raw integer argument registers, optional caller frames and, for an
Objective-C method, the selector read from `_cmd` and the receiver's dynamic
class. Breakpoints stop at the symbol itself, so the registers hold the ABI
arguments. The receiver class comes from LLDB's Objective-C runtime reader
without running target code; no expression is evaluated, and REA never
attaches to a process it did not launch.

The run ends when the process exits, `max_events` entries are recorded,
`duration_ms` elapses, or the aggregate trace resource budget is exhausted.
Bounded termination reports partial coverage. REA checks process termination
using a launch-time OS start identity; if ownership or cleanup cannot be
verified, the result or error preserves that uncertainty. The result reports:

- the outcome, exit status and captured stdout/stderr (1 MiB kept per stream
  while excess bytes are drained and counted without growing capture files).
  Each stream reports `complete`; when draining could not finish, its byte
  count is an observed lower bound and truncation is explicit;
- caller-selected arguments, working directory, and environment overrides;
- `selected_file_sha256` and LLDB module identity observations. These checks do
  not pin the executable against concurrent mutation; `loaded_image_sha256`
  remains unknown;
- signal or exception stops;
- every breakpoint's resolved locations; a breakpoint that matched no loaded
  code makes coverage partial;
- limitations.

The bridge limits retained event JSON to 8 MiB and caller frames to 65,536
across the run. It checks admission before retaining another complete event;
`resource-limit` reports which observations could not be completed without
silently changing the requested event or frame settings.

Only entries are observed: return values, floating-point and stack arguments,
and inlined or `objc_direct` calls are not. The target runs with the current
user's permissions and may change files, show UI or use the network.

Debugging must be allowed for the user (Developer Tools access). A
hardened-runtime target without `com.apple.security.get-task-allow` cannot be
debugged; `inspect_signature` reports this as the debugger-attach facet, and
the tool fails with a `debugger-attach-denied` reason.

## Provider and verification boundaries

Install a Ghidra 12.1.x release and the 64-bit full JDK it declares, then configure REA to
use them. Ghidra analysis supports Linux x64 and macOS x64/arm64; macOS requires
the matching native decompiler. Experimental Windows x64 P0 admits native
x86-64 PE applications on local NTFS using bundled Job Object ownership,
protected runtime DACLs, and handle-based path admission. See [Windows Ghidra P0](windows-ghidra-p0.md) and
[issue #527](https://github.com/morluto/rea/issues/527).
On Linux and macOS, `annotate_native_function` atomically edits a function name
and entry comments in the ephemeral database, returning refreshed analysis
without changing executable bytes. Windows P0 remains read-only. Ghidra has no
GUI authority, and REA never falls back automatically to Hopper.

- `npm run verify:ghidra`: host-native debug/stripped targets, native type layout,
  instruction/call facts, value dependencies and process/project cleanup.
- `npm run verify:ghidra:aarch64-jump-table`: optimized ELF and byte/halfword
  relative tables, plus ARM64 Mach-O on an ARM64 macOS host.
- `npm run verify:apple-dispatch`: source-built Objective-C protocols, classes,
  properties and categories, and Swift conformances and vtables. Each is linked
  with legacy `LC_DYLD_INFO` and with chained fixups (and as arm64e on Apple
  silicon), then repeated after stripping local symbols.
- `npm run verify:native-ui`: one source-owned fixture window, successful
  selected-window capture and actions, changed-target rejection, and cleanup.
  Missing OS permissions fail this lane.
- `npm run verify:native-ui:permissions`: permits a permission-denial result and
  reports `positive_e2e: false` when capture is denied. That result verifies the
  OS permission boundary, not successful UI capture or actions.

macOS ARM64 is the real host verified during this implementation. Admission of
macOS Intel does not claim an Intel verification run. Unsupported metadata and
unresolved runtime/value semantics remain visible in results.
