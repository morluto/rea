# Headerless raw-binary analysis with Ghidra

REA admits a headerless executable when the caller supplies the CPU family and
the address where file offset 0 should be mapped. That interpretation is not
inferred from a `.bin` suffix or from unrecognized bytes.

## Open and inspect

```bash
rea inspect /absolute/path/to/ecu.bin --target-format raw-binary --architecture arm --entry-point 0x8000000 --provider ghidra --json
rea function /absolute/path/to/ecu.bin 0x8000000 --target-format raw-binary --architecture arm --entry-point 0x8000000 --provider ghidra --json
rea inspect-native-load-image /absolute/path/to/ecu.bin --target-format raw-binary --architecture arm --entry-point 0x8000000 --provider ghidra --json
```

```json
{
  "name": "open_binary",
  "arguments": {
    "path": "/absolute/path/to/ecu.bin",
    "format": "raw-binary",
    "architecture": "arm",
    "entry_point": "0x8000000",
    "provider_id": "ghidra"
  }
}
```

`architecture` is one of `x86`, `x86_64`, `arm`, or `arm64`. `entry_point` is a
hexadecimal address of the form `0x…`. The complete file is mapped starting at
that address, and Ghidra seeds an `entry` function there before auto-analysis.
ARM and AArch64 entries must be 4-byte aligned; x86 entries may be byte-aligned.
`open_binary` and an open `binary_session` return the canonical `entry_point`
for raw targets so callers can verify the selected mapping directly.
Omitted `format` keeps header-based detection; architecture and entry without
`format=raw-binary` are rejected.

Ghidra imports a private snapshot with `BinaryLoader` and these little-endian
generic languages and compiler specifications:

| architecture | language_id         | compiler_spec_id |
| ------------ | ------------------- | ---------------- |
| x86          | `x86:LE:32:default` | `gcc`            |
| x86_64       | `x86:LE:64:default` | `gcc`            |
| arm          | `ARM:LE:32:v7`      | `default`        |
| arm64        | `AARCH64:LE:64:v8A` | `default`        |

Compiler specifications select analysis conventions; they do not identify the
original compiler or ABI of a headerless target. Ghidra's x86 languages do not
provide a compiler specification named `default`.

Those settings, the caller-supplied entry, and `language_selection:
caller-supplied-v1` are committed in the analysis profile. A different entry
or architecture is a different profile; snapshots from header-detected targets
do not replay.

The mapped start is independent of Ghidra's program image base, which remains
`0x0` for BinaryLoader. Ghidra may report additional language-defined entry
points, including unmapped ARM vectors. Load-image verification requires the
caller-supplied entry and preserves those other entries as observations.
Independent raw verification streams the complete private snapshot digest and
extent with bounded memory and supports cancellation during the read.

Hopper and IDA refuse raw-binary targets. Windows Ghidra P0 continues to admit
native PE applications and DLLs only; raw-binary targets are unsupported.

## Limitations

- Headers are not discovered from file bytes. This increment does not guess
  load addresses, vector tables, or memory maps.
- Big-endian, Thumb-only, Cortex-M, and other Ghidra processor variants are
  unsupported.
- Reset vectors, memory-mapped I/O, and firmware boot sequences are not
  emulated.
- Independent load-image verification covers source identity, mapped file
  bytes, the bound language, and the caller-supplied entry. Original bytes
  stay unchanged.
