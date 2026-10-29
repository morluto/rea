# Headerless raw-binary analysis with Ghidra

Headerless images are covered here. GameCube/Wii DOL images have a header and
use their own format selection; see [GameCube DOL analysis](ghidra-dol.md).

REA admits a headerless executable when the caller supplies the CPU family and
the address where file offset 0 should be mapped. That interpretation is not
inferred from a `.bin` suffix or from unrecognized bytes. ARM M-profile images
can also name their profile and take their entry from the vector table; see
[ARM M-profile images](#arm-m-profile-images).

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

`architecture` is one of `x86`, `x86_64`, `arm`, `arm64`, `6502`, or `m68k`. `entry_point` is a
hexadecimal address of the form `0x…`. The complete file is mapped starting at
that address, and Ghidra seeds an `entry` function there before auto-analysis.
ARM and AArch64 entries must be 4-byte aligned; m68k entries must be 2-byte
aligned; x86 and 6502 entries may be byte-aligned.
For 6502, the entry and complete mapped file must fit within `0x0000..0xffff`;
images that cross the 16-bit boundary are rejected before provider startup.
For m68k, the mapping must fit within `0x0..0xffffffff`.
`open_binary` and an open `binary_session` return the canonical `entry_point`
for raw targets so callers can verify the selected mapping directly.
Omitted `format` keeps header-based detection; architecture and entry without
`format=raw-binary` are rejected.

Ghidra imports a private snapshot with `BinaryLoader` and these generic
languages and compiler specifications. Each family has one fixed byte order:
m68k is big-endian and the others are little-endian.

| architecture | language_id           | compiler_spec_id |
| ------------ | --------------------- | ---------------- |
| x86          | `x86:LE:32:default`   | `gcc`            |
| x86_64       | `x86:LE:64:default`   | `gcc`            |
| arm          | `ARM:LE:32:v7`        | `default`        |
| arm64        | `AARCH64:LE:64:v8A`   | `default`        |
| 6502         | `6502:LE:16:default`  | `default`        |
| m68k         | `68000:BE:32:default` | `default`        |

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
For 6502, BinaryLoader maps the file before adding its language-defined zero-page
and stack blocks. Conflicting default blocks are skipped; low-address files stay
in the default address space rather than an overlay. Non-conflicting uninitialized
blocks remain observations, not file-backed bytes.
Independent raw verification streams the complete private snapshot digest and
extent with bounded memory and supports cancellation during the read.
It also requires the source-backed block to be initialized, loaded, and
non-overlay in the bound language's default address space. Contradictory mapping
observations are retained with `mismatch`, even when the source hashes agree.

Hopper and IDA refuse raw-binary targets. Windows Ghidra P0 admits native PE
applications/DLLs and explicitly selected raw 6502 images. Other raw CPU families
remain outside the Windows boundary. Native path admission, private DACLs, Job
Object ownership, immutable snapshots, and the no-mutation policy still apply.

## ARM M-profile images

Cortex-M flash images start with a vector table and run only Thumb code. A dump
read from a device, for example with `st-flash read dump.bin 0x08000000 <size>`,
records neither the address it was read from nor the M profile of the core.
Name both:

```bash
rea inspect /absolute/path/to/dump.bin --target-format raw-binary --architecture arm --architecture-variant armv7-m --base-address 0x08000000 --provider ghidra --json
```

```json
{
  "name": "open_binary",
  "arguments": {
    "path": "/absolute/path/to/dump.bin",
    "format": "raw-binary",
    "architecture": "arm",
    "architecture_variant": "armv7-m",
    "base_address": "0x08000000",
    "provider_id": "ghidra"
  }
}
```

`architecture_variant` names the M profile and selects the Ghidra decoder:

| architecture_variant | Profile            | language_id        | compiler_spec_id |
| -------------------- | ------------------ | ------------------ | ---------------- |
| `armv6-m`            | ARMv6-M            | `ARM:LE:32:Cortex` | `default`        |
| `armv7-m`            | ARMv7-M            | `ARM:LE:32:Cortex` | `default`        |
| `armv7e-m`           | ARMv7E-M           | `ARM:LE:32:Cortex` | `default`        |
| `armv8-m.base`       | ARMv8-M Baseline   | `ARM:LE:32:v8-m`   | `default`        |
| `armv8-m.main`       | ARMv8-M Mainline   | `ARM:LE:32:v8-m`   | `default`        |
| `armv8.1-m.main`     | ARMv8.1-M Mainline | `ARM:LE:32:v8-m`   | `default`        |

`ARM:LE:32:Cortex` is Ghidra's ARMv7 decoder with Thumb as the default state. It
has no ARMv8-M encodings, such as the `MSPLIM` and `PSPLIM` system registers that
v8-M startup code sets, so the v8-M and v8.1-M variants use `ARM:LE:32:v8-m`.
Ghidra 12.1.4's `ARM.ldefs` lists `armv8.1-m.main` for that language, which also
decodes ARMv8.1-M encodings such as MVE and the low-overhead loops (`wls`, `le`);
the loop branches' flow is wrong, as Limitations describes.
Neither decoder refuses instructions that a smaller profile lacks: `armv6-m`
code is decoded with the ARMv7-M instruction set, and `armv8-m.main` code with
the ARMv8.1-M one.

- `base_address` maps file offset 0 at its own address, and `entry_point` must
  then lie inside the mapped image. It is required with `architecture_variant`
  and refused without it, the one lane whose verifier covers a separate base. A
  dump records neither its load address nor where Reset is, and mapping it at
  the entry would put a vector table at Reset; a code fragment that starts at
  its entry passes that address as `base_address`.
- Without `entry_point`, REA reads the vector table at `vector_table_address`, or
  at `base_address` when that is omitted. Word 1 is the Reset handler with bit 0
  set for Thumb state. The vector value is observed, and the entry is derived by
  clearing bit 0. Word 0, the initial stack pointer, is recorded as observed and
  is not validated.
- Use `vector_table_address` when a header precedes the vector table, such as the
  256-byte boot2 stage of an RP2040 image or an MCUboot header. It applies only
  when `entry_point` is omitted. The table, whether named or at the base, must be
  128-byte aligned, as VTOR requires (`TBLOFF` holds address bits 31:7), and it
  must lie inside the mapped image.
- REA refuses a Reset word that is even, that points outside the mapped image or
  into the 8 table bytes it read, or that lies past the end of the file. These
  are `load_selection_rejected` refusals with the observed words in
  `details.diagnostics`: a raw dump has no format they can violate, and the usual
  cause is a wrong `base_address`, `vector_table_address` or variant.
- An explicit `entry_point` must be even. An odd value is a Thumb interworking
  address, such as a word copied from the vector table. REA refuses it instead
  of clearing bit 0; `details.diagnostics` in the error give the even
  `code_address` and suggest omitting `entry_point`.
- Each refusal of a load selection is an `invalid_request` with
  `details.constraint: "load_selection_rejected"` and, when one input is to
  blame, that input in `details.field`, such as `entry_point` for an odd Thumb
  entry. The Reset-word refusals name none.

Before auto-analysis, REA's preparation script requires Ghidra's Thumb context
(`TMode=1`) at the entry and seeds the entry there; `inspect_native_load_image`
attests that context independently. Ghidra imports the file without its
processor-defined labels. `ARMCortex.pspec` names the vector table at
`0x0`-`0x40` and marks every handler slot an entry, reserved slots included, so
at base `0x0` its names would cover the table and the code after it. The load
image attests that the seeded entry is the only one.

`npm run verify:ghidra:cortex-m` checks this lane against real Ghidra 12.1.4
with source-owned fixtures and LLVM as the decoding oracle; see
[testing](testing.md).

### Identity and Evidence

A load whose base is its caller-selected entry and that names no variant is the
same load as before these inputs existed, decided on these resolved values. Its
analysis profile, snapshot target, session reuse and `raw-binary` load image are
unchanged. Any other raw load:

- reports `base_address`, `architecture_variant` and, when Reset was read from
  the vector table, `vector_table_address` in `open_binary` and
  `binary_session`;
- commits `raw_load` (`version: 1`) to its analysis profile and snapshot target:
  the base, the variant, the vector table that Reset was read from, and the
  entry's address, instruction set, `role` and `basis`;
- returns the `segments` load image (`layout: "segments"`, `version: 1`): one
  segment backed by the whole file at the base, one entry with its `isa_mode`,
  `role` and `basis`, and, when the basis is the vector table, `vector_table`
  with the table address and the two words read from it, as full-width 32-bit
  words such as `0x080001c5`; the entry holds the canonical code address.

An entry's `role` names its function: `entry` for an entry the caller named,
`reset` for the Reset handler. Its `basis` records how REA chose it: `caller`
or `vector-table`. Ghidra names the function it seeds there `entry` whatever
the role, as its loaders name a program entry; the role, not that name, says
which handler it is.

Identity has two levels:

- Coordinate identity (`function_coordinate_context`) covers only resolved
  values that move coordinates: the decoder, the base, and the entry's decode
  context. Every entry of one image at one base gets the same coordinate
  context, so functions found from a caller-named entry and from Reset compare.
  A legacy load maps file offset 0 at its entry, so there the entry address is
  the base.
- Session and snapshot identity also cover the provenance that results report:
  `raw_load` adds the variant, the vector-table address, and the entry's role
  and basis. The vector words need no place of their own: they are the file
  bytes at the table address, which the file digest and the base fix. A reused
  session never reports a basis or vector words that the current request did
  not produce.

Neither level covers spellings: `0x08000000` and `0x8000000` are the same base,
an omitted `vector_table_address` equals an explicit one at the base, and REA
reports canonical addresses only. No result retains the spelling a caller used
yet; the decision record describes that gap.

These inputs leave a load without them exactly as REA loaded it before: its
analysis profile, snapshot target and `raw-binary` load image are unchanged, so
its saved load images stay readable and its snapshots replay wherever they did
without these inputs. REA versions without these inputs cannot replay a
snapshot of a load that uses them, because its analysis profile differs.

### Decision record

This is decision D1 of the embedded-target work, raised in
[#4246](https://github.com/morluto/rea/issues/4246).

- **Choice.** `architecture_variant` naming the M profile, mapped as in the table
  above; with it, a required `base_address` separate from the entry and an optional
  `vector_table_address`; Reset read from the vector table when a variant and a
  base are given without an entry; explicit odd entries refused; the `segments`
  load image and versioned `raw_load` identity only for loads that are not
  legacy-equivalent; an entry `role` that names its function, with its `basis`
  recorded separately; coordinate identity from resolved values only, while
  session and snapshot identity also cover the provenance that results report;
  Ghidra's processor-defined labels not applied to variant loads.
- **Alternatives.** A single `processor_variant: "cortex-m"` value
  ([#4927](https://github.com/morluto/rea/pull/4927)) cannot select the v8-M
  decoder. Folding ARMv8.1-M into `armv8-m.main` would use the same decoder but
  drop the profile from identity, and splitting it out later would change
  identity again. A language passthrough with a base (#4246, option C) exposes provider
  language ids in a provider-neutral contract. Masking odd entries hides the
  caller's value; refusing first keeps accepting them a later, additive change.
  A `role` that records how the entry was chosen mixes provenance with what the
  entry is. Naming the seeded function after its role, as CMSIS
  `Reset_Handler`, would claim a symbol the image does not carry. Leaving the basis and the vector-table address out of session
  identity would let a reused session report provenance or vector words that
  the current request did not produce. Putting them or the entry address in
  coordinate identity would make functions found from two entries of one image
  incomparable. Ghidra's
  default Cortex labels name every slot, reserved ones included, and at base
  `0x0` the code after the table; the vector table is admission's to read. A
  separate base for every raw family is a later, additive widening; it needs
  base-separated cases in the 6502 and m68k lanes and on Windows Ghidra P0,
  which admits raw 6502.
- **Owner and consumers.** `src/domain/architectureVariant.ts` owns the
  vocabulary; `GHIDRA_VARIANT_LANGUAGES` owns the Ghidra mapping, which
  follows the GNU architecture names in Ghidra 12.1.4's `ARM.ldefs`, and
  `GHIDRA_VARIANT_LIMITATIONS` the decoder limitations that every lane
  reports for a variant; raw
  admission owns the load, its legacy equivalence, the entry's role and basis,
  and its `raw_load` identity; the Ghidra profile owns the coordinate context
  and the label policy. Consumers are the CLI and MCP inputs, target summaries,
  the Ghidra profile, launcher, bridge and load-image attestation, and
  snapshots.
- **Costs of change.** Code: renaming an input is an alias with a deprecation
  period; remapping a variant or adding an M profile is one table row. Every
  row is an ARM M profile, and the base requirement, Reset derivation and label
  policy hold for all of them; a variant of another family would first make
  those per-row properties of the table. Compatibility: the `segments`
  shape and `raw_load` are permanent once released, so changes ship as
  `version: 2`. Their variant and instruction-set values are closed sets, so a
  version that predates a new value refuses the Evidence or snapshot instead of
  misreading it. The `segments` and `entries` arrays hold one element today and
  leave room for more; `vector_table` holds only the table address and the two
  words read, under the `segments` version. Migration: sessions and snapshots of
  loads that use these inputs are invalidated by any change to `raw_load`;
  legacy loads are not affected. Verification: rerun
  `npm run verify:ghidra:cortex-m`, which needs Ghidra 12.1.4, JDK 21 and LLVM
  with Thumb targets.
- **Known gap.** Results report the canonical `entry_point`, `base_address` and
  `vector_table_address`; none retains the spelling the caller passed, as
  legacy `entry_point` did not before these inputs. Direct CLI requests keep
  the caller's path as Evidence `caller_input_path`, outside semantic identity.
  Recording a load selection's spellings the same way would be a later change,
  but not one older readers accept: the Evidence envelope is strict, so REA
  versions without the new field refuse records that carry it. A caller that
  needs its spelling keeps its own request: an MCP client already holds its
  arguments, and a CLI caller can save its command beside the Evidence it
  writes, together with its `evidence_id`.

## NMOS 6502

```bash
rea function /absolute/path/to/image.bin 0x8001 --target-format raw-binary --architecture 6502 --entry-point 0x8001 --provider ghidra --json
rea inspect-native-load-image /absolute/path/to/image.bin --target-format raw-binary --architecture 6502 --entry-point 0x8001 --provider ghidra --json
```

Select only headerless NMOS 6502 code with a known entry at file offset 0.
The built-in Ghidra processor supplies static instructions, functions,
pseudocode, and references. Evidence preserves `architecture: "6502"`, the
selected language, entry, file digest, and verified source mapping. Register and
calling conventions are analysis conventions, not a recovered source ABI.

This lane does not interpret iNES headers, cartridge mappers, bank switching,
or other console-specific memory layouts. 65C02 and 65816 programs need different
processor semantics and are not admitted as those variants. REA does not infer
the CPU from the file suffix, guess the reset vector, or emulate the target.

`npm run verify:ghidra:6502` assembles and links the source-owned fixture with
`ca65` and `ld65` (tested from cc65 tag `V2.19`, whose tools report `V2.18`).
Set `REA_CA65` and `REA_LD65` to explicit executable paths if needed. The lane
checks real CLI/MCP load-image parity, mapped bytes, decoded calls, decompilation,
invalid mappings, unchanged source bytes and runtime cleanup.
Low-memory checks include a file spanning the zero-page/stack boundary at `0xff`
and a complete 64-KiB image at `0x0`, with verified default-space mappings through
both CLI and MCP. On Windows, the lane also checks that a caller-selected
junction path is rejected at snapshot admission through CLI and MCP, with
unchanged source bytes and complete runtime cleanup. Windows requires the
matching native addon; the POSIX provider path has not been exercised by the
Windows run.

## Motorola 68000

```bash
rea function /absolute/path/to/image.bin 0x1000 --target-format raw-binary --architecture m68k --entry-point 0x1000 --provider ghidra --json
rea inspect-native-load-image /absolute/path/to/image.bin --target-format raw-binary --architecture m68k --entry-point 0x1000 --provider ghidra --json
```

Select only headerless big-endian 68000-family code with a known, even entry at
file offset 0. Ghidra's `68000:BE:32:default` language decodes the 68040
superset in the 32-bit `ram` address space. Instructions that a real MC68000
would not execute are therefore not rejected, and 68020, 68030, CPU32, and
ColdFire programs are not admitted as those variants. Addresses are not masked
to the MC68000 24-bit bus. Evidence preserves `architecture: "m68k"`, the
selected language, entry, file digest, and verified source mapping. Register and
calling conventions are analysis conventions, not a recovered source ABI.

This lane does not interpret Amiga hunks, Atari ST, or other container headers,
cartridge or console memory maps, or bank switching. REA does not read the
initial stack pointer and reset vector from the first eight bytes; select the
entry explicitly. Windows Ghidra P0 does not admit m68k.

`npm run verify:ghidra:m68k` uses a source-owned 22-byte fixture written as
annotated hex in the verifier, so it needs no assembler. The lane checks real
CLI/MCP load-image parity, mapped bytes, a decoded call, decompilation by address
and file offset, misaligned and out-of-range mappings, unchanged source bytes and
runtime cleanup. It has been run with Ghidra 12.1.4 on macOS; Linux has not been
exercised.

## Limitations

- Headers are not discovered from file bytes. REA does not guess load
  addresses, profiles, vector-table locations, or memory maps.
- Big-endian ARM is unsupported, and m68k is the only big-endian family.
  `architecture_variant` names only the ARM M profiles; no other processor of a
  family, such as the 65C02 or ColdFire, can be selected.
- An M-profile load maps one segment: the file at its base. SRAM, peripheral and
  system blocks are not created, and only the Reset vector is read. Ghidra's
  processor-defined vector labels are not applied, so other vectors are neither
  entries nor labels. Floating-point state, TrustZone and device memory maps are
  not modelled.
- Ghidra 12.1.4 decodes the ARMv8.1-M low-overhead-loop branches `wls` and `le`
  with the right mnemonics, but not their flow. In the verifier's Cortex-M55
  image, `wls` branched 2 bytes short of its target, `le` branched 4 bytes past
  the loop start, and `le` had no fall-through. Code after such a loop may be
  left undisassembled; `armv8.1-m.main` results say so.
- Reset vectors, memory-mapped I/O, and firmware boot sequences are not
  emulated.
- Independent load-image verification covers source identity, mapped file
  bytes, the bound language, and the caller-supplied entry. Original bytes
  stay unchanged.
