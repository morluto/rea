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

Hopper's `address_to_file_offset` combines the native image-relative mapping with
original-file coordinates only after checking the source against the session's
SHA-256. FAT tables and embedded Mach-O headers come from that same hashing pass.
A changed or nonregular source reports `artifact_changed`; an unreadable or
missing source reports its access or filesystem failure. Those errors retain the native offset,
loaded header and provider source path in `details.partial_observation`, with the
original-file coordinate explicitly unavailable. Restore the original bytes or
reopen the changed executable to obtain verified coordinates. Snapshot replay
remains historical evidence for its recorded artifact identity.

A selected Hopper database's digest identifies the database rather than its
original executable. Original-file mapping is unavailable for that selection;
native mapping facts remain in partial evidence, and `read_bytes` still reads
the loaded database. Open the original executable to verify source coordinates.

Native Xcode command execution uses shared process supervision with a 60-second
deadline and a 64 MiB aggregate stdout/stderr budget. Timeout, cancellation,
stream failure, and output exhaustion retain the captured output, exit details,
and cleanup outcome in the error result. Truncated output is never parsed as a
complete observation.

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
  App bundle `Info.plist` executable resolution uses the same decoder as keyed
  archives and Interface Builder. The decoder consumes an initial
  BOM and rejects malformed byte sequences, unsupported encoding declarations,
  and declarations that disagree with the detected encoding. It never substitutes
  UTF-8 for a declared encoding it cannot process. Archive and evidence digests
  still identify the original serialized bytes. Bundle resolution reports
  malformed bytes and unsupported encodings against the original plist path
  before looking up the executable. Interface Builder decoding
  limits aggregate input archives to 32 MiB.
  Before decoding, it also bounds the serialized structure: expanded binary
  plist references, NIB table records, XML elements and text, plus their
  projected representations must fit the 256 MiB aggregate decode budget.
  NIB string values, data, property names and class names are charged at each
  projected JSON occurrence, including when the archive reuses one source
  value. Binary plist data projection also accounts for the temporary byte
  copy made by the pinned decoder projection. These are format-derived
  representation reservations, not exact heap measurements or a process-wide
  heap ceiling.
  Archives beyond either aggregate budget are omitted with their paths and an
  explicitly partial `archive_decode` facet; previously decoded documents and
  their identities remain available.
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

## Exact CLI selectors

`function`, `instructions` and `decompile` accept `--procedure=<name-or-address>`;
`xrefs` accepts `--address=<name-or-address>`. `search` accepts `--pattern=<text>`
and `trace` accepts `--query=<text>`. These alternatives preserve names and text
that begin with a dash, including Objective-C names such as
`rea function ./app '--procedure=-[REAWidget delegate]' --provider hopper --format json`.
Use the equals form when the value resembles a CLI flag, for example
`rea trace ./app --query=--help --provider hopper --format json`.
The existing positional forms remain available. Missing selectors and conflicting
positional/named values fail before analysis starts; identical selections agree.

## Native instruction, call and type primitives

Ghidra supplies three exact-object operations:

Ghidra accepts hexadecimal addresses with or without a `0x` prefix, in either
letter case, and explicit address-space coordinates such as `EXTERNAL:0x1`.
Results use canonical lowercase hexadecimal offsets. For a procedure identifier,
an explicit `0x` or address-space prefix selects an address; otherwise an exact
database symbol name takes precedence over a bare hexadecimal address. Thus a
function renamed to `dead` remains selectable by name. Use the names returned
by the inventory, including their namespaces and any platform symbol prefix.
Overloads can share a fully qualified name; ambiguity errors return every
matching entry address so the caller can select the intended function directly.

`resolve_containing_procedure` also resolves an exact external entry. Its empty
body remains explicit; nearby external addresses do not inherit that identity.

Ghidra function references cover the complete function-body AddressSet and its
exact entry, including references into instruction interiors and references
from embedded data. Addresses inside an enclosing span but outside the owned
body are excluded. `procedure_references` returns internal and external edges;
`analyze_function` omits incoming edges whose sources belong to the same function.
The reference collector's semantics participate in the analysis profile, so
older snapshots cannot replay the former incomplete results under this profile.

Ghidra regex searches use Java Pattern semantics. If compiling or matching a
pattern exhausts the engine's stack, REA returns a resource constraint and
preserves the active database and annotations. Retry in literal mode or simplify
the regex; successful literal searches retain complete matching strings.
Cancelling an active request terminates the ephemeral database and discards its
annotations. REA retains the selected target and imports the original artifact
again on the next Ghidra query.

Opening the same target and profile again retains the live database, including
annotations. It does not make those edits eligible for an immutable snapshot.
Snapshot closes drain earlier provider requests before saving and keep later
requests waiting until the save and close finish. A concurrent successful edit
therefore rejects the snapshot save and leaves the edited session open.
After metadata edits, snapshot saves and imports remain unavailable in that
session. Use `export_evidence_bundle` to retain the observations, close without
`snapshot_path`, and reopen the target before importing or saving a snapshot.

Ghidra checks its private import copy against the artifact digest selected by
`open_binary`. If the source changes before that copy is acquired, the query
reports `artifact_changed` with the selected path and both digests. Reopen the
stable target to acquire its current identity. An already imported database
continues to describe its captured bytes even if the original path is changed
or removed; this identity failure does not mark the Ghidra installation unavailable.
On Linux and macOS, an unreadable source reports `access_denied`; a removed or
nonregular replacement reports `artifact_changed`. Source copying is cancellable
and never replaces an existing private snapshot.

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
Resolved breakpoint locations have a separate aggregate 8 MiB metadata budget.
If their details exceed it, `location_count` retains the full observed match
count, coverage is partial, and `breakpoint_locations_truncated` is true. This
post-run metadata limit does not imply that the target was killed.

Accepted entries and signal stops are also flushed to a bounded 8 MiB journal.
If cancellation, timeout, capture failure, or a later bridge error prevents a
full result, the error retains this evidence in `details.partial_observation`
with partial coverage. Available output prefixes remain inline; their byte
counts are observed lower bounds when final drain counters are unavailable.
The original failure classification and cleanup uncertainty remain separate.
An interrupted journal row is ignored with an explicit limitation.

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
without changing executable bytes. Annotation text must contain no NUL or
unpaired Unicode surrogate; a rejection identifies the field and UTF-16 index
and leaves every annotation unchanged. CRLF, supplementary Unicode characters,
and combining characters are preserved. Windows P0 remains read-only. Ghidra has no
GUI authority, and REA never falls back automatically to Hopper.
Ghidra name edits preserve the existing namespace. Supply either a leaf name
such as `renamed` or a fully qualified name in that namespace, such as
`alpha::renamed`. The returned qualified name can be reused as an idempotent
rename input. Edits retain the existing namespace; other namespace-like text
remains literal leaf-name text. A qualified name with an empty leaf is rejected
before any comment or name is changed.

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

## Interface Builder hierarchy coverage

A keyed-archive hierarchy UID without an object-table entry marks the hierarchy
as partial while preserving decoded objects and known links. UID 0 remains
archived nil and does not count as a missing reference. Archive and evidence
digests identify the original serialized bytes.

## Keyed archive integer precision

The archive reader observes XML number element types and binary number markers.
Integers beyond the exact range of a JSON number are reported with the original
decimal text as `{ "$plist_type": "integer", "decimal": "<exact digits>" }` when
that source value can be associated unambiguously. Integral real values remain
numbers. Colliding integer/real values, unclassified numbers, and malformed UID
markers remain decoded with an explicit precision limitation. The limitation
also counts observed unsafe integer literals, including observations outside the
selected object page. Incomplete supplemental metadata produces an explicit
precision note without rejecting an archive accepted by the byte decoder.
Mixed XML number content (comments, CDATA, processing instructions or child
elements) and integer text the supplemental reader cannot classify disable exact
association and retain decoded numbers with that precision note. Nonnumeric
`UID` and `CF$UID` dictionary values remain ordinary data and are projected
recursively; numeric reference markers retain their original representation.

Value projection preserves serialized node kinds, IDs, references and pagination.
Exact and ambiguous value counts describe emitted root/object value instances;
a root and an object may contain the same value. Archive digests identify the
original bytes.
