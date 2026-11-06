# LoongArch ELF analysis through Ghidra

This lane extends native ELF analysis to 64-bit little-endian LoongArch; it
does not execute LoongArch code. It admits both distribution/toolchain
conventions commonly called the **new world** (object ABI v1) and the **old
world** (object ABI v0), and names which one the header declares in the
analysis profile and Evidence limitations. Other LoongArch profiles (ILP32,
big endian, soft-float and single-float ABIs, relocatable objects) remain
unsupported and are refused with a specific reason.

## Admission boundary

ELF `EM_LOONGARCH` (258) is retained as the provider-neutral `loongarch`
family. The target also retains class, byte order, `e_type`, raw `e_flags`,
and the declared floating-point and object ABIs.

The Ghidra lane admits ELF64 little-endian `ET_EXEC` and `ET_DYN` images whose
`e_flags` declare the LP64D double-float ABI and no bits outside the fields
below. Shared objects are the primary target: stripped DRI drivers expose only
their dynamic symbol exports, and Ghidra recovers the remaining functions from
call analysis and exception unwind data.

| `e_flags` field    | Bits | Admitted values                        |
| ------------------ | ---- | -------------------------------------- |
| floating-point ABI | 0-2  | `0b011` (LP64D, double float) only     |
| object ABI version | 6    | set (v1, new world) or clear (v0, old) |
| any other bit      | —    | must be zero                           |

`EF_LARCH_ABI_MODIFIER_MASK` (0x07) values 0 (unspecified), 1 (LP64S,
soft float), 2 (LP64F, single float) and 4-7 (reserved) are refused. The
soft-float modifier is not silently mapped to a double-float language even
though Ghidra's `loongarch.opinion` maps `.001` to `lp64d`: Ghidra 12.1.4
ships no LP64S compiler specification, and its decompiler would misstate
floating-point argument storage. The LP64F language exists but has no
verified argument-ABI lane.

`EF_LARCH_OBJABI_V1` (0x40) marks object ABI v1. Its absence selects object
ABI v0, so v0 is an inference from the absence of a flag rather than a
separate declaration. Both versions share the same instruction encoding; the
declared version selects linker, PLT and dynamic-loader conventions. Static
analysis does not emulate those conventions, and a PLT stub's computed jump is
not evidence of a resolved callee.

ELF32 (ILP32), big-endian images and `ET_REL` objects are refused. Ghidra
12.1.4 ships little-endian languages only; an ILP32 psABI lane and per-section
relocatable load coordinates need separate verification.

## Bound language

The lane imports with `Loongarch:LE:64:lp64d` and compiler specification
`default`, commits that choice in the analysis profile as
`language_selection: "provider-pinned-v1"`, and checks the language Ghidra
reports after import. The pin does not accept Ghidra's header auto-selection:
the loader's opinion file maps both the double-float modifier (`.011`) and the
soft-float modifier (`.001`) to `lp64d`, so only the derived admission decides
whether an image may be imported.

A caller-selected `REA_GHIDRA_LANGUAGE_ID`/`REA_GHIDRA_COMPILER_SPEC_ID` that
differs from the pinned LP64D language is a configuration error naming the
conflicting settings; the requested override is not applied. An identical
override is recorded as `language_selection: "configured-v1"`. The pin is an
analysis convention, not evidence of the producing compiler or of verified
instruction semantics.

Header facts are committed in the analysis profile as `loongarch_elf` plus a
support-lane token such as `elf64-le-dyn-lp64d-objabi-v1-generic-v1`, so an
interpretation change invalidates profile-bound snapshots. A committed profile
is bound to the current target's lane and ELF declarations before startup;
reusing a profile resolved for the other object ABI version or load model is
refused rather than exporting attribution for a target it did not describe.

## Shared objects and relocations

`ET_DYN` addresses are Ghidra analysis coordinates, not runtime load
addresses; the loader places the image at its analysis base (`0x100000` for
the DRI drivers checked here). Ghidra applies the dynamic relocations its
LoongArch handler implements — notably `R_LARCH_RELATIVE`, `R_LARCH_64`,
`R_LARCH_JUMP_SLOT`, `R_LARCH_32` and the in-place ADD/SUB family — to loaded
memory.

The handler does not implement every relocation type. TLS
`R_LARCH_TLS_DTPMOD*`, `R_LARCH_TLS_DTPREL*`, `R_LARCH_TLS_TPREL*`, COPY and
other types are reported as unsupported and remain unapplied. Thread-local
storage and copied-data conclusions must therefore be checked against the
source bytes. Ghidra also does not run `ld.so`: external PLT/GOT bindings stay
unverified without the defining images, and the measured relocation status is
retained by `inspect_native_load_image` observations (the ELF format itself has
no independent load-image verification).

## Use

With a caller-installed Ghidra and compatible JDK on a supported Ghidra host:

```bash
rea analyze /absolute/path/to/gsgpu_dri.so --provider ghidra --json
rea function /absolute/path/to/gsgpu_dri.so --procedure __driDriverGetExtensions_gsgpu --provider ghidra --json
rea decompile /absolute/path/to/oldw_gsgpu_dri.so --procedure __driDriverGetExtensions_gsgpu --provider ghidra --json
```

MCP uses the existing tools, including `open_binary` with an absolute path and
`provider_id: "ghidra"`. No LoongArch-specific tool catalog or emulator is
introduced. Hopper and IDA adapters do not implicitly gain LoongArch support;
Windows Ghidra P0 currently admits PE, DOS MZ and raw 6502 targets only; it
does not admit ELF.

## Verification

The source-owned fixture is `tests/conformance/c/loongarch.c` with fixed
instruction encodings in `tests/conformance/ghidra/loongarch-probe.S`. The
optional lane requires a caller-supplied LoongArch GNU cross toolchain, GNU
`readelf`, Ghidra and its compatible JDK; ordinary host-native checks do not
acquire these tools. `REA_LOONGARCH_GCC` selects the compiler and
`REA_LOONGARCH_READELF` selects readelf. These are test-time prerequisites, not
REA runtime providers.

```bash
GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra npm run verify:ghidra:loongarch
```

The lane builds a shared object (`ET_DYN`) with the toolchain's declared
new-world `e_flags` and an executable (`ET_EXEC`), then derives an old-world
declaration fixture by clearing `EF_LARCH_OBJABI_V1` in a copy. The transform
changes only the ELF declaration; instruction bytes remain the new-world
toolchain's output, which the lane states in its report. Fixture code is never
executed.

GNU readelf independently supplies header facts and symbol addresses, compared
with the production REA target resolver before provider startup. Existing
public MCP operations check Ghidra's observed language and compiler
specification, fixed probe instruction bytes, a global's bytes at its
independently reported symbol address, decompilation liveness, profile and
snapshot identity, and final process cleanup. Pseudocode presence is a
liveness check, not proof of semantic equivalence. Neither the fixture nor
reader agreement establishes runtime or complete floating-point semantics.
