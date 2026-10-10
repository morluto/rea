# MIPS ELF analysis through Ghidra

This lane extends native ELF analysis; it does not execute MIPS code or rehost
firmware. It advances the generic-MIPS portion of
[#718](https://github.com/morluto/rea/issues/718), not the whole firmware roadmap.
PSP/Allegrex has a [separate static-ELF profile](ghidra-psp.md) tracked in
[#1330](https://github.com/morluto/rea/issues/1330).

## Admission boundary

ELF `EM_MIPS` is retained as the provider-neutral `mips` family. The target also
retains class, byte order, `e_type`, raw `e_flags`, and inspected ABI declarations.
Recognition does not mean every provider or MIPS variant is supported. Existing
PE, managed and Mach-O architecture sets are unchanged.

The first Ghidra lane admits ELF32 `ET_EXEC`, little or big endian, with explicit
o32 and `EF_MIPS_ARCH_32R2` flags and no machine-specific or ASE encoding flags.
These are header declarations, not proof that every instruction conforms to
that ISA. ELF64, n32/n64, unspecified ABI, MIPS16/microMIPS, machine-specific
variants, shared/relocatable objects and PSP PRX are not covered by this lane.
Their family may be identified, but provider selection returns the specific
unsupported constraint rather than guessing a compatible profile.

Explicit `EF_MIPS_FP64` and `EF_MIPS_NAN2008` declarations are refused. Their
absence is insufficient: Clang can emit identical `e_flags` for FP32, FP64 and
soft-float targets. Target resolution also reads the 24-byte ABI flags record
identified by `PT_MIPS_ABIFLAGS` and/or `SHT_MIPS_ABIFLAGS`, without relying on
section names or the record being inside the initial 4 KiB header probe.
Program and section declarations must agree; duplicate, conflicting, truncated
or out-of-file records are rejected. Stripped section tables and section-only
records are supported. Extended table numbering is explicitly unsupported.
The field layout follows
[`Elf_MIPS_ABIFlags_v0`](https://github.com/bminor/glibc/blob/master/elf/elf.h).

Provider admission requires record version 0, MIPS32r2, 32-bit GPR/CPR1, no CPR2,
and a double-precision or FPXX ABI declaration with no ISA extension, ASE or
unknown general flags. Missing records remain unknown rather than defaulting
to a compatible ABI, and this initial lane refuses them. Unknown record values
are retained for diagnosis but do not gain provider support. These checks bind
the declared interpretation; the integer-only fixture does not establish full
floating-point behavioral conformance.

MIPS header and ABI record facts are committed in the analysis profile so
interpretation changes invalidate profile-bound snapshots. The support-lane
identity is versioned independently of file identity. Evidence, lifecycle
outputs and saved snapshots preserve the `mips` family. Hopper and IDA adapters
do not implicitly gain MIPS support. Windows Ghidra P0 remains PE x86/x86-64 only.

## Use

With a caller-installed Ghidra and compatible JDK on a supported Linux/macOS host:

```bash
rea analyze /absolute/path/to/mips.elf --provider ghidra --json
rea function /absolute/path/to/mips.elf function_name --provider ghidra --json
```

MCP uses the existing tools, including `open_binary` with an absolute path and
`provider_id: "ghidra"`. No MIPS-specific tool catalog or emulator is introduced.
Inspect instructions, caller relationships and data alongside pseudocode. In
particular, delay-slot semantics are supplied by Ghidra, not reconstructed by
REA's ELF parser.

## Verification

The source-owned freestanding fixture is `tests/conformance/c/mips.c`. The
optional cross-target lane requires a caller-supplied Clang with MIPS targets,
LLD, GNU `readelf`, Ghidra and its compatible JDK; ordinary host-native checks
do not acquire these tools. `REA_MIPS_CLANG` selects Clang and
`REA_MIPS_READELF` selects GNU readelf (for example `greadelf` on macOS).
These are test-time prerequisites, not REA runtime providers.

```bash
GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra npm run verify:ghidra:mips
```

The lane compiles both byte orders and never executes the targets. GNU readelf
independently supplies header/ABI facts and symbol addresses, compared with the
production REA target resolver before provider startup. Its version, bounded
command output and selected tool path are retained in the verification report.
The parser deliberately recognizes only this fixture's GNU output, rejecting
missing, ambiguous or unexpected fields rather than substituting defaults.

Existing public MCP operations check Ghidra's **observed** language/compiler
specification and loaded-file hashes. The source-owned `mips-probe.S` supplies
fixed ADDIU and conditional-branch encodings: verification checks bytes, length,
immediate and direct destination, independent of decompiler variable names.
Global and string bytes are checked at independently reported symbol addresses.
ELF load-image results retain observations even though REA's independent
load-image comparison currently covers DOS, not ELF; this lane checks those
observations and does not relabel the upstream result as verified.

CLI/MCP discovery and decompilation, direct calls, target/profile/Evidence
identity, snapshot round-trip and final process cleanup remain covered.
Pseudocode presence is a liveness check, not proof of semantic equivalence.
Instruction decoding and reader agreement likewise do not establish runtime,
delay-slot execution or complete floating-point semantics. Assertion regressions
reject incorrect byte order, constants, destinations and loaded identities.
Parser/profile tests are narrower checks, not substitutes for this real-provider
run. Report the actual lanes run and leave unexecuted verification pending.
