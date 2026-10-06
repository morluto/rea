# Native, managed, and packaged artifacts

## Native targets

After `open_binary`, use focused search, procedure, or function tools directly.
Use `binary_overview` when target metadata or inventory context helps answer the
question. Prefer literal search, names, decompilation, callers, callees, and
cross-references. Addresses and recovered pseudocode are analysis observations,
not original source. Provider unavailability and unsupported metadata remain
unknown rather than false.

Use `binary_session` with no arguments to check the open target, selected
provider, and alignment. Its default `result.tool_availability` includes the
complete tool inventory with availability reasons and remediation. When choosing
a tool, use its entry in that result; `tools/list` retains the complete catalog
when the target or provider state changes.

## DOS MZ with Ghidra

For an admitted DOS MZ target, use `inspect_native_load_image` to check measured
loaded bytes, file mappings, relocations and the entry against the immutable
snapshot. Keep `mismatch` and `unsupported` explicit. Verified import covers the
reported static image, not runtime DOS or PC-98 hardware behavior.

Use `read_bytes` for initialized analysis memory and `address_to_file_offset` to
anchor one observed address to original file bytes. Loader fixups can change a
word; a source offset does not imply byte equality. Complete function body ranges
use inclusive ends and can contain gaps. Do not treat the enclosing span as code.
For packed targets, retain the original and separately derived artifact identities;
decompiling an unpacking stub does not recover the unpacked program.

## Managed PE/CLI

Start with `inspect_managed_artifact`. REA's canonical managed inspection is
execution-free: do not claim it loaded, reflected, executed, or resolved the
assembly. Keep managed/native boundaries and unavailable reconstruction facts
explicit. A bring-your-own reconstruction oracle is separate from the canonical
parser and must not become an implicit setup dependency.

## .NET NativeAOT

A NativeAOT PE/ELF contains native code. Absence of PE/CLI metadata does not mean
analysis must stop at assembly. Use native function analysis for recovered
pseudocode; it is not reconstructed original C#.

With an explicitly configured NativeAOT Ghidra adapter, call
`inspect_native_load_image` after opening the target. Its optional
`observations.metadata_recovery` returns the format, positive header evidence,
coverage, derived-memory identity and type addresses/category paths inline.
Then inspect a reported type with `inspect_native_data_type`, follow its
`metadata_recovery.related_type`, interfaces and virtual slot addresses, and use
`analyze_function` plus string/xref searches for implementation evidence. Keep
`not_applicable`, partial recovery and unsupported layouts explicit. Generated
`Class_address` names and inferred System.Object/String identities are not
original names; custom field layouts remain unknown.

Recovery modifies an ephemeral analysis database and may replace loaded metadata
bytes with derived content. Original executable files remain unchanged. Distinguish
original file offsets from derived analysis memory. Windows x64 PE **targets**
can be analyzed on a supported Linux host; Windows **host** P0 does not admit
this database recovery. See the [NativeAOT guide](https://github.com/morluto/rea/blob/main/docs/ghidra-nativeaot.md)
for the tested layout and optional bring-your-own adapter build.

## Packages and extraction

Use `inspect_artifact` for application bundles, archives, ZIP/APK/IPA/MSIX/AppX,
ASAR, or DMG inputs when the artifact graph and findings help answer the
question. It returns the complete artifact graph inline. Cite graph manifest
IDs when using them.

Use `extract_artifact` when materialized files are needed. It takes no arguments
and materializes all regular files into a fresh temporary directory chosen by
REA. Symlinks and encrypted entries are inventory facts, not extractable files.
The result reports the materialized directory; callers do not choose the
destination. No separate permission grant is needed.

Native DMG traversal automatically uses a read-only mount on supported macOS
hosts, with an owned temporary mount directory and cleanup. It needs no approval
flag. Unsupported hosts or mount failures remain explicit limitations; do not
claim child inventory when only root identity is available. Extraction is a
separate filesystem-writing operation.

For headerless DOS COM, explicitly open with `format: "dos-com"` (CLI
`--target-format dos-com`). Inspect the load image before trusting function
analysis: the entry is `0x10100`, file offset zero, with imposed real-mode segment
context. PSP/stack/device state remains unmodeled. See [DOS guide](https://github.com/morluto/rea/blob/main/docs/ghidra-dos.md).

### Function annotations in Ghidra

Use `annotate_native_function` for one function name and/or entry comments, with at least one explicit change. Review its annotation readback and refreshed dossier inline. Changes are atomic and session-scoped; empty comments clear them, omitted fields preserve them. Later MCP calls observe edits until close. CLI `annotate-native-function` returns the updated analysis before discarding the session. Original executable bytes are unchanged; edits invalidate immutable snapshots. Windows P0 does not admit database mutations.
