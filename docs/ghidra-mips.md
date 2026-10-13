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

The Ghidra lane admits ELF32 `ET_EXEC` and `ET_REL`, little or big endian, with
explicit o32 and `EF_MIPS_ARCH_32R2` flags and no machine-specific or ASE
encoding flags. These are header declarations, not proof that every instruction
conforms to that ISA. ELF64, n32/n64, unspecified ABI, microMIPS,
machine-specific variants and PSP PRX are not covered by this standard-instruction
lane. MIPS16 shared images have the separate bounded profile below; other shared
or compressed images remain unsupported. Their family may be identified, but provider selection returns the
specific unsupported constraint rather than guessing a compatible profile.

A second admission covers recordless legacy firmware images
([#1620](https://github.com/morluto/rea/issues/1620)): ELF32 `ET_EXEC` headers
declaring `EF_MIPS_ARCH_32` or `EF_MIPS_ARCH_32R2` with an unspecified ABI
field, `EF_MIPS_ABI2` clear, and an _inspected_ absence of any ABI flags
record (a target whose record was merely not observed stays refused). For
these images o32 is an analysis assumption derived from the ELF32/ET_EXEC
structure, recorded as `mips_abi_basis` in the profile and stated as a
limitation in Evidence, never a declared fact; floating-point ABI semantics
stay unverified. Ghidra's own header auto-selection picks a 64-bit language
for exactly these files, so the lane pins `-processor MIPS:<LE|BE>:32:default`
through a `provider-pinned-v1` profile selection and checks the
bridge-reported `language_id` after import. A caller-selected
`REA_GHIDRA_LANGUAGE_ID`/`REA_GHIDRA_COMPILER_SPEC_ID` still wins over the
pin; combining the pinned profile with an environment override is a typed
refusal. A header that declares an ABI field but carries no record is still
refused. Two further boundaries apply: an inspection that could not examine
every ABI declaration source (for example a carved ELF whose section table
extends past the captured bytes without a program-header record) does not
establish the recordless admission, and an `EF_MIPS_ARCH_32` header that
_declares_ an ABI is refused rather than relabeled, because the declared-ABI
lane is verified for `EF_MIPS_ARCH_32R2` headers only.

Explicit `EF_MIPS_FP64` and `EF_MIPS_NAN2008` declarations are refused. Their
absence is insufficient: Clang can emit identical `e_flags` for FP32, FP64 and
soft-float targets. Target resolution also reads the 24-byte ABI flags record
identified by `PT_MIPS_ABIFLAGS` and/or `SHT_MIPS_ABIFLAGS`, without relying on
section names or the record being inside the initial 4 KiB header probe.
Program and section declarations must agree; duplicate, conflicting, truncated
or out-of-file records are rejected. Stripped section tables and section-only
records are supported. Extended table numbering is explicitly unsupported.
For carved ELFs whose section table extends beyond the captured file, REA
examines every complete captured section header and records the unavailable
headers as a limitation. A valid program-header ABI record can still establish
the supported declaration. Available section declarations must agree with it;
their duplicate, conflicting or unreadable records remain errors. A missing
program-header record does not make ABI declarations in uncaptured sections
absent or supply a default ABI.
The field layout follows
[`Elf_MIPS_ABIFlags_v0`](https://github.com/bminor/glibc/blob/master/elf/elf.h).

Provider admission on the declared-ABI lane above requires record version 0,
MIPS32r2, 32-bit GPRs, no CPR2, no ISA extension, ASE or unknown general
flags, and one of two floating-point declarations: 32-bit CPR1 with a
double-precision or FPXX ABI, or no CPR1 with the soft-float ABI. Other
combinations, including single-float, FP64 and unspecified ABIs, are refused.
Missing records remain unknown rather than defaulting to a compatible ABI, and
the declared-ABI lane refuses them; the recordless legacy admission above is
the only path that admits a recordless image. Unknown record
values are retained for diagnosis but do not gain provider support. These checks
bind the declared interpretation; the fixtures do not establish full
floating-point behavioral conformance.

### MIPS16 shared images

A separate profile admits ELF32 `ET_DYN`, either byte order, declaring explicit
o32, MIPS32r2 and exactly the MIPS16 ASE. Machine variants, n32, FP64 and NAN2008
remain refused. Source inspection must examine the complete dynamic relocation
declarations through uniquely mapped file-backed `PT_LOAD` ranges. This profile
verifies `R_MIPS_NONE` and symbol-index-zero `R_MIPS_REL32`; section declarations
must describe that same dynamic table. Unavailable section headers and additional
section relocation tables (including `--emit-relocs` output) remain unsupported.
Symbol-bearing REL32,
other relocation types, RELA and PLT declarations remain unsupported. A real
negative control shows that Ghidra can normalize a symbol-bearing MIPS16 function
pointer to an even address, losing the source mode tag. REA refuses that shape
rather than rewriting the source or silently repairing the analysis result.

The profile pins the endian-matched `MIPS:<LE|BE>:32:default` processor and default
compiler specification, and checks the bridge-reported language after import.
The generic processor preserves mixed MIPS32/MIPS16 code through per-address
`ISA_MODE` context; a global `16e` processor would impose one mode across the
image. A caller-selected incompatible processor or compiler specification is
explicitly refused without replacing the requested choice.

An observed ABI flags record must agree with the header and MIPS16 ASE, and
must declare the same verified floating-point combinations as the standard
lane. With no observed record, every ABI declaration table must have been
completely examined. The header still declares o32, but floating-point ABI
semantics remain unknown and are stated in Evidence; selecting the default
compiler specification does not establish floating-point storage. Partial
section tables do not prove record absence. The existing soft-float prototype
policy applies when the source explicitly declares soft-float.

Returned addresses are analysis coordinates, not runtime load addresses.
`inspect_native_load_image` preserves original relocation bytes, current loaded
memory bytes and provider status. External GOT bindings remain unverified
without their defining images. The provider's `modified_sha256` describes its
ephemeral relocated image and can differ from `original_sha256`; it does not
mean that the caller's artifact was written. `inspect_native_instruction` retains the program
language variant in `mode` and reports actual per-address `ISA_MODE` separately
in `decoder_context`, including null when unavailable. Artifact bytes and digests
remain unchanged; this workflow does not execute the shared library.

The optional real-provider check builds eight source-owned GNU controls, covering
both byte orders, mixed MIPS32/MIPS16 code, declared and absent ABI records, and
the rejected symbol-bearing and additional section relocations. It compares source instruction bytes,
function symbols and the local function-pointer tag with actual CLI/MCP results,
checks context through a snapshot round trip, and verifies process cleanup.
It requires caller-supplied GNU MIPS cross-binutils and Ghidra; no fixture target
is executed or patched after linking. Floating-point behavior of compressed
functions is not established by these integer controls.

```bash
REA_MIPS_AS=/absolute/path/to/mips-linux-gnu-as \
REA_MIPS_LD=/absolute/path/to/mips-linux-gnu-ld \
GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra \
npm run verify:ghidra:mips-shared
```

MIPS header and ABI record facts are committed in the analysis profile so
interpretation changes invalidate profile-bound snapshots. The support-lane
identity is versioned independently of file identity. Evidence, lifecycle
outputs and saved snapshots preserve the `mips` family. Hopper and IDA adapters
do not implicitly gain MIPS support. Windows Ghidra P0 does not admit MIPS targets.

### Soft-float prototype

Ghidra's MIPS32 compiler specifications model hard-float o32 only: a typed
`float` or `double` parameter is bound to `$f12`/`$f14` and returned in `$f0`.
Soft-float o32 passes those values in integer registers and stack slots, so a
typed prototype (for example from DWARF) would make the decompiler read FPU
registers the code never writes and drop the real dataflow. That applies to
functions, external functions and indirect calls through typed function
pointers alike.

For soft-float targets REA commits
`mips_soft_float_storage: o32-soft-float-prototype-v1` in the analysis profile
and runs `ReaGhidraMipsSoftFloat.java` after auto-analysis. The script encodes
the program's own default o32 prototype, removes its floating-point parameter
and return entries and the rules that consume floating-point storage, and
installs the result as the program-specific `__rea_soft_float` prototype through
a Ghidra specification extension. Deriving it keeps the byte-order-specific
aggregate rules and the hidden struct-return pointer. The script then assigns
that prototype, with dynamic storage, to every non-thunk function and external
function, and to every function-pointer definition, whose declared types use
`float` or `double`. Thunks follow their targets. Types are kept.

The script fails, and writes no report, if the derived prototype still places a
float in an FPU register or any reassigned function does. It records the
function and definition counts last; REA requires that report exactly when the
profile commits the policy and refuses the session otherwise, before serving any
operation. Session Evidence carries the policy and counts as limitations.
Callables without typed float signatures keep Ghidra's default prototype, under
which Ghidra already infers integer-register parameters. Hard-float profiles do
not gain the policy, so their digests are unchanged.

### Relocatable objects

`ET_REL` objects, such as Linux kernel modules (`.ko`), are imported by Ghidra's
ELF loader, which assigns each allocated section an analysis address and applies
the object's REL relocations there. Undefined symbols are placed in Ghidra's
`EXTERNAL` block: a thunk for code, a label for data. These addresses are
analysis coordinates, not the addresses a kernel or linker would choose, and
session Evidence says so. `inspect_native_load_image` reports each relocation
with Ghidra's status; HI16 entries report `PARTIAL` because Ghidra applies them
together with their paired LO16. Relocatable targets commit
`mips_support_lane: elf32-rel-o32-arch32r2-standard-v1`, separate from the
executable lane, whose identity executable targets keep. Kernel modules are
usually soft-float and therefore also use the soft-float storage policy.

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

### Executables

The source-owned freestanding fixture is `tests/conformance/c/mips.c`; the
soft-float variant also links `tests/conformance/c/mips-soft-float.c`. The
optional cross-target lane requires a caller-supplied Clang with MIPS targets,
LLD, GNU `readelf`, Ghidra and its compatible JDK; ordinary host-native checks
do not acquire these tools. `REA_MIPS_CLANG` selects Clang and
`REA_MIPS_READELF` selects GNU readelf (for example `greadelf` on macOS).
These are test-time prerequisites, not REA runtime providers.

```bash
GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra npm run verify:ghidra:mips
```

The lane compiles both byte orders with hard-float and soft-float ABIs and never
executes the targets. GNU readelf
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
For both byte orders, the lane also carves away the section table while retaining
all program-header payloads. It checks the actual Ghidra language, entry-address
decompilation, distinct artifact digest and missing-section limitations through
CLI Evidence and an MCP-produced snapshot. Caller-selected Ghidra heap limits
are passed to these child workflows.
For soft-float fixtures the lane also checks, through `inspect_native_api`, the
exact parameter and return types and storage of float, double, mixed (pair
alignment and stack spill) and struct-returning functions; that a caller's
decompilation receives every source float constant without FPU inputs,
including an indirect call through a typed function pointer; and that the
snapshot profile and Evidence retain the policy and outcome counts.
Pseudocode presence is a liveness check, not proof of semantic equivalence.
Instruction decoding and reader agreement likewise do not establish runtime,
delay-slot execution or complete floating-point semantics. Assertion regressions
reject incorrect byte order, constants, destinations and loaded identities.
Parser/profile tests are narrower checks, not substitutes for this real-provider
run. Report the actual lanes run and leave unexecuted verification pending.

### Relocatable objects

This lane has its own command and fixture:

```bash
GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra npm run verify:ghidra:mips-relocatable
```

It compiles `tests/conformance/c/mips-relocatable.c` with `-c -G0` in both byte
orders, plus a little-endian soft-float `-mlong-calls` variant matching Linux
module options. GNU readelf independently supplies sections, symbols and REL
entries. For every relocation in an allocated section, the lane reads the
loaded word through `read_bytes` and requires it to encode `S + A`: `S` from
Ghidra's own section placement (`list_segments`) or `EXTERNAL` placement, `A`
from the original file bytes. HI16/LO16 are checked as the effective address
each LO16 forms with each HI16 it resolves, including several HI16s before one
LO16, so a missing signed-low carry fails and a HI16 without a following LO16
fails. The lane also requires matching Ghidra relocation entries and statuses,
section file offsets and sizes, coverage of a shared HI16, a LO16 resolving
several pending HI16s (from an assembly block, since Clang does not emit that
from C), a LO16 carry, external code and data and `R_MIPS_32` words, direct
calls from the entry
function, the relocatable support lane in the snapshot profile, the
relocatable limitation in Evidence and an unchanged source object. The fixture
also calls `powf`, an external whose float prototype comes from Ghidra's C
library archive; every variant must decompile `powf(1.5,2.5)` without FPU
inputs, and the soft-float variant must report that the soft-float prototype
covered it.
