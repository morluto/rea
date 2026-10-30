# Mach-O debug companion analysis with Ghidra

REA can admit a caller-selected `.dSYM` bundle beside a Mach-O executable so
Ghidra's DWARF analysis recovers parameter names, data types, and source-anchored
type identity that the stripped executable cannot provide. The companion is
never inferred: REA stages it only when the caller selects it, and only when it
provably belongs to the target.

## Open and inspect

```bash
rea inspect /absolute/path/to/pair --provider ghidra --dsym-path /absolute/path/to/pair.dSYM --json
rea function /absolute/path/to/pair _pair_sum --provider ghidra --dsym-path /absolute/path/to/pair.dSYM --json
```

```json
{
  "name": "open_binary",
  "arguments": {
    "path": "/absolute/path/to/pair",
    "dsym_path": "/absolute/path/to/pair.dSYM",
    "provider_id": "ghidra"
  }
}
```

`dsym_path` names a `.dSYM` bundle directory whose `Contents/Resources/DWARF`
member carries the target image's `LC_UUID`. Admission rejects the request as
caller input — `invalid_request` / `invalid_input` with the
`debug_companion_rejected` constraint — when the bundle is missing, is not a
bundle, or contains no DWARF member whose UUID matches the target. A target
without any `LC_UUID` cannot be matched and is rejected explicitly. Omitting
`dsym_path` keeps today's behavior: the executable is analyzed alone.

`dsym_path` applies only to detected Mach-O executable targets
(`mach-o` and `mach-o-universal`); pairing it with `format=raw-binary` or
`format=dos-com` is rejected. Only the Ghidra provider stages the companion
today; other providers leave it unused.

## How the companion reaches Ghidra

Ghidra's `DSymSectionProvider` locates external DWARF by strict file naming:
`<executable name>.dSYM/Contents/Resources/DWARF/<executable name>` beside the
imported binary. REA imports a private, digest-verified snapshot of the target,
so the original bundle beside the original file is never visible to the
session. Admission therefore stages the matched DWARF member inside REA's
private runtime root under the snapshot's name, with the caller's bundle
untouched. The staged member's SHA-256, the source bundle path, and the matched
UUID are retained as target-admission evidence.

On a compiled fixture (`clang -O0 -g`, linked, `dsymutil`) a function analyzed
without the companion reports `signature_source: "default"` and low return-type
confidence; with the matching companion the same function reports
`signature_source: "imported"`, a by-value `Pair` parameter with the original
parameter name, field names in pseudocode, and the DWARF type path in value
flow.

## Limitations

- UUID matching is REA-side and mandatory; Ghidra itself does not verify that a
  located dSYM belongs to the imported image.
- Only the DWARF member that carries the matching UUID is staged; source file
  contents referenced by DWARF are not resolved.
- The selected architecture slice of a universal target must be covered by a
  matching member UUID in the bundle; per-slice selection inside the bundle is
  not exposed.
- Admission examines at most 16 DWARF directory entries, including entries
  that are not regular files. The matched member may be at most 1 GiB.
- UUID traversal incrementally reads command headers and UUID payloads with a
  cached window of at most 64 KiB. Large command bodies are skipped rather than
  allocated or classified as malformed solely for their size. At most 64 MiB
  is read across the target and all member candidates; this is an explicit
  workflow I/O budget, rather than a Mach-O format limit.
