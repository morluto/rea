# PowerPC ELF analysis through Ghidra

This lane extends native ELF analysis to 32-bit big-endian PowerPC and to
64-bit PowerPC (PPC64) executables that use the ELFv2 ABI, in either byte
order; it does not execute PowerPC code. The 32-bit lane is the first milestone
of [#1741](https://github.com/morluto/rea/issues/1741), and the PPC64 lane
answers [#12085](https://github.com/morluto/rea/issues/12085). GameCube/Wii DOL
executables are covered by [GameCube DOL analysis](ghidra-dol.md). ELFv1 PPC64,
PPC64 shared images and other PowerPC variants remain separate follow-ups.

## Admission boundary

ELF `EM_PPC` (20) is retained as the provider-neutral `powerpc` family, and so
is `EM_PPC64` (21) when the header is ELF64. An ELF32 header that claims
`EM_PPC64` stays unrecognized. The target also retains class, byte order,
`e_type` and raw `e_flags`; for `EM_PPC64` the low two bits of `e_flags` declare
the ELFv1 or ELFv2 ABI. Recognition does not mean every provider or PowerPC
variant is supported. Static ELF readers are unchanged: they report the machine
as `ppc64` and their Evidence subject carries no family for it.

The 32-bit Ghidra lane admits ELF32 `ET_EXEC`, big endian. Little-endian,
relocatable and shared objects are refused with a specific unsupported
constraint. `EF_PPC_EMB` declares an embedded variant and is refused; the
remaining `e_flags` bits only declare relocation conventions and do not change
instruction decoding.

The PPC64 Ghidra lane admits ELF64 `ET_EXEC` whose `e_flags` declare the ELFv2
ABI (2), little or big endian. ELFv1 (1) calls go through `.opd` function
descriptors and an undeclared ABI (0) does not say which convention the code
follows, so both are refused, as are other `e_flags` bits. Shared objects,
position-independent executables (both `ET_DYN`) and relocatable objects need
separate load verification and are refused with a specific unsupported
constraint.

## Bound language

Ghidra's ELF loader selects `PowerPC:BE:32:e500:default` for a plain `EM_PPC`
header with `e_flags` 0. e500 is the embedded Book-E variant whose SPE unit
replaces the classic floating-point unit, so it misinterprets ordinary
750-family code. Nothing in the header distinguishes the two.

The 32-bit lane therefore imports with `PowerPC:BE:32:default` and compiler
spec `default`, commits that choice in the analysis profile as
`language_selection: "provider-pinned"`, and checks the language Ghidra
reports after import. A different language set through
`REA_GHIDRA_LANGUAGE_ID` (and optionally `REA_GHIDRA_COMPILER_SPEC_ID`)
replaces the lane default and is admitted against the installed language
catalog as usual; for example `PowerPC:BE:32:e500` for genuine e500 code.

For PPC64, Ghidra 12.2 offers two languages per byte order:
`PowerPC:LE:64:default` (and `BE`), described as G2-era 64-bit PowerPC with
AltiVec, and `PowerPC:LE:64:A2ALT` (and `BE`), described as Power ISA 3.0 with
AltiVec. Despite its name, A2ALT is the one that decodes current server code.
In POWER8 and POWER9 builds the `default` language stops at the first VSX
instruction: the lane's `xxlor` probe is reported `not-in-listing`, while A2ALT
decodes it. The ELF loader selects A2ALT today in both byte orders. The lane
imports with `PowerPC:LE:64:A2ALT` or `PowerPC:BE:64:A2ALT` by byte order and
compiler spec `default`, commits it as `provider-pinned`, and checks the
language Ghidra reports after import. Because the language is passed
explicitly, a later loader that prefers another variant does not change how
these files decode. `REA_GHIDRA_LANGUAGE_ID` replaces it as above, for example
with `PowerPC:LE:64:default` for G2-era code.

PowerPC header facts are committed in the analysis profile so interpretation
changes invalidate profile-bound snapshots. The support-lane identity
(`elf32-be-exec-generic` or `elf64-elfv2-exec-isa3`) is versioned independently
of file identity. Evidence, lifecycle outputs and saved snapshots preserve the
`powerpc` family. Hopper and IDA adapters do not implicitly gain PowerPC
support. Windows Ghidra P0 remains PE x86/x86-64 only.

## ELFv2 entry points

An ELFv2 function that uses the TOC has two entry points. The global entry, at
the symbol value, derives `r2` from `r12`; the local entry follows it, at the
offset the symbol's `st_other` declares (8 bytes for the usual two-instruction
prologue), and is where callers that share the TOC branch. Ghidra keeps the
symbol name on the global entry, models it as a thunk, and puts the body in a
function at the local entry whose name has a leading dot (`.name`).

REA reports what Ghidra built. `analyze_function` or `rea function` on the
symbol returns the thunk, with `classification.thunk_target` naming the local
entry, and its pseudocode follows the thunk into the body. Callees and
assembly belong to the local entry, and direct calls between such functions
resolve to the callee's local entry.

## Use

With a caller-installed Ghidra and compatible JDK on a supported Linux/macOS host:

```bash
rea analyze /absolute/path/to/ppc.elf --provider ghidra --json
rea function /absolute/path/to/ppc.elf function_name --provider ghidra --json
```

MCP uses the existing tools, including `open_binary` with an absolute path and
`provider_id: "ghidra"`. No PowerPC-specific tool catalog or emulator is
introduced.

## Verification

The source-owned freestanding fixture is `tests/conformance/c/ppc.c`. The
optional cross-target lane requires a caller-supplied Clang with the PowerPC
target, LLD, GNU `readelf`, Ghidra and its compatible JDK; ordinary host-native
checks do not acquire these tools. `REA_PPC_CLANG` selects Clang and
`REA_PPC_READELF` selects GNU readelf (for example
`/opt/homebrew/opt/binutils/bin/readelf` on macOS). These are test-time
prerequisites, not REA runtime providers.

```bash
GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra npm run verify:ghidra:ppc
```

The lane compiles the fixture for a 750-family core (`-mcpu=750`) and never
executes it. GNU readelf independently supplies header facts and symbol
addresses, compared with the production REA target resolver before provider
startup. Its version, bounded command output and selected tool path are
retained in the verification report. The parser deliberately recognizes only
this fixture's GNU output, rejecting missing, ambiguous or unexpected fields
rather than substituting defaults.

Existing public MCP operations check Ghidra's **observed** language and
compiler specification and loaded-file hashes; an e500 import fails the lane.
The source-owned `ppc-probe.S` supplies fixed `addi` and conditional-branch
encodings: verification checks bytes, length, immediate and direct destination,
independent of decompiler variable names. Global and string bytes are checked at
independently reported symbol addresses.

CLI/MCP discovery and decompilation, direct calls, target/profile/Evidence
identity, snapshot round-trip and final process cleanup remain covered.
Pseudocode presence is a liveness check, not proof of semantic equivalence.
Instruction decoding and reader agreement do not establish runtime or complete
floating-point semantics. Parser/profile tests are narrower checks, not
substitutes for this real-provider run. Report the actual lanes run and leave
unexecuted verification pending.

The PPC64 lane has its own command, with the same tools and variables:

```bash
GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra npm run verify:ghidra:ppc64
```

It builds `tests/conformance/c/ppc64.c` and `ppc64-probe.S` for POWER9 with
`-mabi=elfv2` in both byte orders (Clang's big-endian Linux default is ELFv1)
and never executes them. GNU readelf supplies header facts, symbol addresses
and ELFv2 local-entry offsets, compared with the production target resolver.
Through MCP and the CLI the lane checks the observed language; the fixed
`addi`, `beq` and VSX `xxlor` encodings in the file's byte order, with the
immediate and branch destination; the global doubleword and marker bytes; that
each C function's global entry is a thunk to its local-entry body and that the
body's direct call reaches the leaf's local entry; pseudocode presence; the
address-to-file-offset mapping; Evidence and snapshot identity, including the
profile language and lane; and that a position-independent shared object is
refused before Ghidra starts.
