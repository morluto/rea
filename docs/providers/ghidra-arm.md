# 32-bit ARM (armhf) analysis through Ghidra

This lane extends native ELF analysis for 32-bit ARM images; it does not execute
ARM code or rehost firmware. It addresses
[#1745](https://github.com/morluto/rea/issues/1745): the `arm` entry in the
provider-neutral architecture set is now backed by a verified lane instead of a
bare allowlist, and Ghidra header auto-selection is not used for the admitted
shape because it has several plausible wrong answers for ARM/Thumb-2 interworked
images.

## Admission boundary

ELF `EM_ARM` targets retain class, byte order, `e_type`, and raw `e_flags` as
provider-neutral facts. Recognition does not mean every ARM variant is
supported.

The lane admits little-endian ELF32 `ET_EXEC` images declaring EABI5 whose
`.ARM.attributes` declare `Tag_CPU_arch` v7 with the Application profile, the
variant the verification build covers. Only the hard-float (`armhf`,
`EF_ARM_ABI_FLOAT_HARD`) convention is covered; `EF_ARM_ABI_FLOAT_SOFT` and an
unspecified float convention are refused, as are images declaring
`Tag_DIV_use=2` or a nonzero `Tag_Virtualization_use` (for example
`-march=armv7ve`), because the build probes no hardware-divide or
virtualization instruction. ELF64 AArch64 images use the separate
`arm64` lane. Big-endian `armeb`, `EF_ARM_BE8` mixed-endian images, older or
legacy ABIs, PIE (`ET_DYN`), shared images and relocatable objects are not
covered, and neither are images declaring another ISA (for example `v8-A`) or
profile (for example the Realtime profile a cortex-r5 build declares), an
unknown profile, or no readable declaration at all, because the EABI version
and the arch enum alone do not identify the CPU variant: provider selection
returns the specific unsupported constraint rather than guessing a compatible
profile. When the section table extends beyond the captured file, admission is
refused: an unexamined header could carry another .ARM.attributes
declaration, so a partial scan never establishes the ISA. An attributes
section over the inspection bound is refused with that recorded reason. Only
a non-null section header can own `.ARM.attributes`, and a declared range
overlapping the ELF header, the section header table, or the program header
table is rejected rather than read as an ISA declaration.

## Pinned import language

For the admitted shape REA pins `-processor ARM:LE:32:v7` with the default
compiler spec and checks the bridge-reported `language_id` after import, the
same mechanism the DOS lanes use. A caller-selected
`REA_GHIDRA_LANGUAGE_ID`/`REA_GHIDRA_COMPILER_SPEC_ID` still wins over the pin;
combining the pinned profile with an environment override is a typed refusal
that asks for a reopen without the override.

The profile records the lane identity `elf32-exec-le-eabi5-v7-pinned`, the
raw header facts, and the declared float ABI basis without interpreting it
into a calling-convention claim.
Sessions carry the limitation that the ELF float ABI declaration does not
change the modeled calling convention.

## Verification

`npm run verify:ghidra:arm` builds a source-owned freestanding fixture with
Clang (`arm-linux-gnueabihf`, ARMv7-A, hard float, linked with `lld`)
containing both an ARM-mode probe and a Thumb-2 interworked probe with fixed
reviewable encodings, checks REA's ELF interpretation against GNU readelf
(with the attributes-stripped refusal variant built by `llvm-objcopy`,
GNU `objcopy` when it can read ARM input, or a built-in ELF section-header
neutralizer when neither can), asserts the pinned language after import, decodes both
instruction-set states, walks a snapshot round-trip, and proves typed
refusals for legacy-EABI, BE8, v8-A, Realtime-profile, and stripped
attributes variants plus CLI/MCP parity. No third-party binary is analyzed
and no target code is executed. The build tools can be redirected with
`REA_ARM_CLANG` and `REA_ARM_READELF`; `REA_ARM_OBJCOPY` is optional and, when
set, is the only objcopy tried: its failure fails the lane. Without it, the
objcopy candidate is selected by performing the strip, not by asking for its
version, so a GNU objcopy built without the ARM target falls through instead of
failing the lane. The verification report records which tool built the variant.
