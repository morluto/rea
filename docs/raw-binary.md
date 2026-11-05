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

`architecture` is one of `x86`, `x86_64`, `arm`, `arm64`, or `cortex-m`.
`entry_point` is a hexadecimal address of the form `0x…`. The complete file is
mapped starting at that address. For `x86`, `x86_64`, `arm`, and `arm64`,
Ghidra seeds an `entry` function there before auto-analysis. For `cortex-m`,
that address is the vector-table base: the first word is the initial stack
pointer and the second is the reset vector. REA clears the reset vector's
Thumb bit, decodes that address as Thumb, and names the function
`reset_handler`. ARM, AArch64, and Cortex-M bases must be 4-byte aligned; x86
entries may be byte-aligned. A Cortex-M image must contain at least those
eight bytes.
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
| cortex-m     | `ARM:LE:32:Cortex`  | `default`        |

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

Hopper and IDA refuse raw-binary targets. Windows Ghidra P0 admits headerless
raw-binary images, including Cortex-M, and remains read-only. PE admission is
unchanged.

## Hardware claims

A hardware statement uses one rule and one basis. The same rules cover
controller names, architectural registers, board windows, values computed by
the image, installed parts, and driver strings.

| Rule                    | Settled basis         | Stays unsettled when                                                                                              |
| ----------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `observed-address`      | `observed_address`    | the address comes from rounding a page the instruction did not access                                             |
| `chip-manual-name`      | `chip_manual`         | no observed address falls inside a controller window of the active chip map                                       |
| `architecture-register` | `architecture_manual` | the register address is chosen by the board, such as a GIC, CLINT, or PLIC base                                   |
| `explicit-profile`      | `explicit_profile`    | the CPU family alone would assign a board memory window or register placement                                     |
| `instruction-decode`    | `instruction`         | the image's own bit operations do not compute the split                                                           |
| `installed-part`        | `observed_address`    | the table only lists supported chips, even a single name, until a separate observation identifies the fitted chip |
| `driver-linkage`        | `observed_address`    | a string's presence is treated as proof that the driver runs during boot                                          |
| `board-record`          | none                  | the board record itself leaves the statement open, such as a color disagreement                                   |

Only a settled basis may be stated as fact. A claim keeps the subject, source,
rule, and reason of the fact it came from. An open color note stays a board
record. It is not rewritten as an installed-part question. A driver claim keeps
that driver's id and the evidence that names the captured image.
`decideHardwareClaim` applies these rules.

## Limitations

- Headers are not discovered from file bytes. The caller still supplies the
  load address. `cortex-m` reads the vector table at that address; it does not
  guess a different base.
- Big-endian ARM and Thumb-only variants other than `cortex-m` are unsupported.
- `cortex-m` seeds in-image vectors whose low bit is set. Memory-mapped I/O
  and firmware boot sequences are not emulated. `reset_handler` is an assigned
  analysis name, not a symbol recovered from the image.
- Independent load-image verification covers source identity, mapped file
  bytes, the bound language, and the caller-supplied entry. Original bytes
  stay unchanged.
