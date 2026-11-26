# Firmware CPU architecture and load-base candidates

`inspect_firmware_architecture_candidates` /
`rea inspect-firmware-architecture-candidates` inspects one local firmware blob,
flash dump, or container image and returns ranked CPU family, word-size,
byte-order, and ARM M-profile load-base candidates without opening a
disassembler session or changing [`open_binary`](../../providers/raw-binary.md)'s
explicit-choice contract.

```sh
rea inspect-firmware-architecture-candidates /artifacts/firmware.bin --json
rea inspect-firmware-architecture-candidates /artifacts/flash.bin --max-scan-bytes 8388608 --json
```

```json
{
  "name": "inspect_firmware_architecture_candidates",
  "arguments": {
    "path": "/artifacts/firmware.bin"
  }
}
```

## Detectors and confidence classes

Every call runs four static byte detectors over the examined prefix
(`min(file_size, max_scan_bytes)`) and records each detector's coverage in
`detectors`:

| Detector                       | Confidence | What it establishes                                                                                                                              |
| ------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `embedded-elf-census`          | `observed` | Validates `0x7f 'E' 'L' 'F'` fixed headers (`EI_CLASS`, `EI_DATA`, `EI_VERSION`, `e_type`, `e_machine`) and tallies CPU families                 |
| `uimage-header`                | `derived`  | Validates U-Boot `0x27051956` headers and header CRC32 (`image_check_hcrc`), retaining raw `ih_arch` beside its U-Boot `include/image.h` name    |
| `cortex-m-vector-table`        | `inferred` | Checks 128-byte aligned M-profile vector tables (`initial_sp` in SRAM, odd Thumb Reset and exception handlers, zeroed reserved slots)            |
| `instruction-signature-census` | `inferred` | Counts aligned prologue and return encodings across `arm64`, `arm` (A32 and Thumb), `mips` (LE/BE), `powerpc` (BE), `riscv`, `x86_64`, and `x86` |

- **U-Boot `uImage` addresses**: `load_address` and `entry_point` are declared
  header facts for the payload following the 64-byte header (possibly compressed
  per `ih_comp_name`), never a file-offset-0 mapping of the input file.
- **Embedded ELF consensus**: `elf_census.consensus` reports `unanimous`,
  `majority` (strictly above half of validated headers), `mixed`, or `absent`.
  When no strict majority exists, `consensus` stays `mixed` with a limitation
  rather than picking a winner.
- **Cortex-M load-base candidates**: When a qualifying M-profile vector table is
  present in the leading 64 KiB (including offset tables such as `0x100` boot2
  prefixes or `0x200` MCUboot headers), `load_base_candidates` reports the
  candidate `base_address`, `vector_table_address`, `initial_sp`, and
  `reset_code_address`.
- **Instruction census margin**: `instruction_census` reports per-signature hit
  counts, alignment, density per KiB, `leader_profile_id`,
  `runner_up_profile_id`, and `margin_hits` across qualifying profiles. Profiles
  require at least two distinct prologue/return signature families and a
  size-scaled hit floor so single-opcode runs, random bytes, zero-filled spans,
  and `0xFF` erased flash return `status: "unknown"`. Shared RV32/RV64 RISC-V
  compressed and base prologue/return signatures preserve `word_size: "unknown"`
  unless container headers establish 32-bit or 64-bit width.

## Explicit unknowns and `open_binary` handoff

When no detector qualifies, `status` is `"unknown"` (never `"none"`),
`candidates` is empty, and `detectors` records the exact byte count each
detector examined.

Each candidate includes `raw_binary_support`:

- `admitted_today`: whether [`open_binary` `format=raw-binary`](../../providers/raw-binary.md)
  currently admits that candidate without unresolved profile or load-base inputs
  (`x86`, `x86_64`, little-endian A32 `arm`, Cortex-M vector-table `arm` with a
  derived `base_address` and caller-selected M-profile `architecture_variant`,
  little-endian `arm64`, `6502`, and big-endian `m68k`; Thumb opcode matches
  without a vector table leave the ARM profile and load addresses unresolved);
- `open_binary_arguments`: suggested arguments when admitted, without applying
  them automatically;
- `rizin_decoder_hint`: `asm_arch` and `asm_bits` for one-shot
  `execute_rizin_command` inspection when `raw-binary` does not admit the target
  and the candidate's decoder bit width is known.

## Budgets and recovery

| Parameter        | Default | Minimum | Ceiling | Controls                                                       |
| ---------------- | ------: | ------: | ------: | -------------------------------------------------------------- |
| `max_file_bytes` |  64 MiB |    16 B | 256 MiB | Whole-file admission size (`details.limit` parameter recovery) |
| `max_scan_bytes` |   4 MiB |    64 B |  64 MiB | Prefix bytes examined (`partial` coverage when smaller)        |
