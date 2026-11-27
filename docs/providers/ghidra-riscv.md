# RISC-V ELF analysis through Ghidra

This lane extends native ELF analysis for `EM_RISCV` targets. It does not
execute RISC-V code, emulate a boot sequence, or rehost firmware. It addresses
[#2063](https://github.com/morluto/rea/issues/2063) and follows the same
lane shape as [generic MIPS support](ghidra-mips.md).

## Admission boundary

ELF `EM_RISCV` (243) is retained as the provider-neutral `riscv` family. The
target also retains the raw ELF declarations that decide a lane: class, byte
order, `e_type`, `e_flags`, and the ISA string that `.riscv.attributes`
declares. Recognition does not mean every provider or RISC-V variant is
supported. Existing PE, managed and Mach-O architecture sets are unchanged.
Headerless inputs use the separate [raw-binary admission
boundary](raw-binary.md); raw RISC-V images are not supported.

The Ghidra lane admits little-endian `ET_EXEC` images and position-independent
executables (`ET_DYN` with `PT_INTERP`) with no `EF_RISCV_RVE`, `EF_RISCV_TSO`,
or any bit outside `EF_RISCV_RVC | EF_RISCV_FLOAT_ABI`, in one of the supported
lanes:

- ELF64 or ELF32 images that declare `EF_RISCV_FLOAT_ABI_DOUBLE` use Ghidra's
  stock double-float model unchanged. Their `.riscv.attributes` is not read for
  admission.
- ELF32 `ET_EXEC` images that declare the soft-float ABI (`e_flags` float-ABI
  bits `0`, ilp32) use REA's [ilp32 calling-convention policy](#ilp32). They
  must also declare an RV32I base and only [decoded extensions](#isa-declarations)
  in `Tag_RISCV_arch`. Soft-float PIE images remain refused.
- ELF32 `ET_EXEC` images that declare `EF_RISCV_FLOAT_ABI_SINGLE` (ilp32f)
  use REA's [ilp32f calling-convention policy](#ilp32f). They must declare an
  RV32I base, the F extension, only decoded extensions, and not the D
  extension. Single-float PIE images remain refused.

These are header declarations, not proof that every instruction conforms to
that ISA.

Provider selection returns the specific unsupported constraint rather than
guessing a compatible profile:

| Declaration                                                                           | Outcome                                                                                                                         |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Little-endian ELF64 `ET_EXEC` or PIE (`ET_DYN`), double-float ABI                     | admitted, `RISCV:LE:64:default` + `gcc`, lane `elf64-exec-le-double-float-generic-v1` or `elf64-pie-le-double-float-generic-v1` |
| Little-endian ELF32 `ET_EXEC` or PIE (`ET_DYN`), double-float ABI                     | admitted, `RISCV:LE:32:default` + `gcc`, lane `elf32-exec-le-double-float-generic-v1` or `elf32-pie-le-double-float-generic-v1` |
| Little-endian ELF32 `ET_EXEC`, soft-float ABI, decoded extensions only                | admitted, `RISCV:LE:32:default` + `gcc` with the `__rea_ilp32` prototype, lane `elf32-exec-le-soft-float-generic-v1`            |
| Little-endian ELF32 `ET_EXEC`, single-float ABI, F and decoded extensions             | admitted, `RISCV:LE:32:default` + `gcc` with the `__rea_ilp32f` prototype, lane `elf32-exec-le-single-float-generic-v1`         |
| ELF32 soft-float PIE (`ET_DYN`)                                                       | refused; soft-float position-independent executables need separate load verification                                            |
| ELF32 soft- or single-float ABI without `Tag_RISCV_arch`, or with any other extension | refused; the reason names the extensions outside the decoded set                                                                |
| ELF32 single-float ABI without the F extension                                        | refused; the ABI needs F                                                                                                        |
| ELF32 single-float ABI with the D extension                                           | refused; Ghidra's model preserves more of `fs0`–`fs11` than the ABI does                                                        |
| ELF32 single-float image whose signatures `__rea_ilp32f` cannot express               | refused after analysis; the reason names the signatures ([ilp32f](#ilp32f))                                                     |
| ELF32 single-float PIE (`ET_DYN`)                                                     | refused; single-float position-independent executables need separate load verification                                          |
| ELF64 soft- or single-float ABI (lp64, lp64f), or the quad-float ABI                  | refused; no verified calling-convention policy                                                                                  |
| Big-endian                                                                            | refused; the 12.2 language definitions contain no big-endian RISC-V language                                                    |
| `ET_DYN` without `PT_INTERP` (shared library)                                         | refused; shared libraries without PT_INTERP need separate load verification                                                     |
| `ET_REL`, other `e_type`                                                              | refused with the declared value                                                                                                 |
| `EF_RISCV_RVE`                                                                        | refused; the embedded 16-register profile (x0–x15) needs its own processor specification                                        |
| `EF_RISCV_TSO`                                                                        | refused; the total-store-order memory model is unverified here                                                                  |
| Reserved or newer `e_flags` bits                                                      | refused with the offending bits named                                                                                           |
| One NOBITS section covering an `ET_EXEC` code section from its start                  | admitted if no other section overlaps either; REA prepares the [memory map](#load-layout) before analysis                       |
| The same reservation in a position-independent executable (PIE)                       | refused; REA verifies that preparation for `ET_EXEC` images only                                                                |
| Any other section overlap involving executable code                                   | refused; the reason names the two sections that cause the refusal, with their ranges                                            |
| A section table that cannot be read, or with more than 65,280 allocated sections      | refused with the read failure or the count; REA rejects most malformed tables when it opens the file                            |

`e_type`, program headers and, for executables, the
[section overlaps](#load-layout) decide the load model this lane reads. A
fixed-address `ET_EXEC` declaration does **not** establish static linkage:
dynamic dependencies are not inspected, and the session records that boundary
as a limitation rather than inferring a load model. Position-independent
executables (`ET_DYN` with `PT_INTERP`) are admitted using Ghidra's default
analysis base (`0x10000` for RV32, `0x100000` for RV64); runtime load addresses
and dynamic linker relocations are not executed or verified.

## Why the language is pinned

Ghidra's header-based selection is not reliable for RV32. In the 12.2 release
tree, `riscv.opinion` pins `variant="default"` for the 64-bit constraint and
leaves the 32-bit constraint unpinned with the comment that the loader "must
choose between 'default' and 'AndeStar' variants". Auto-selection was measured
against the earlier 12.1.4 release tree and has not been re-measured on 12.2:

| Fixture                                         | Ghidra auto-selection         |
| ----------------------------------------------- | ----------------------------- |
| RV64 ELF, `e_flags 0x5` (RVC, double-float ABI) | `RISCV:LE:64:default:gcc`     |
| RV32 ELF, `e_flags 0x5`, no Andes declaration   | `RISCV:LE:32:AndeStar_v5:gcc` |

So, on that 12.1.4 tree, an ordinary RV32 image lands on an Andes processor
model unless the language is stated. REA therefore pins `RISCV:LE:32:default` or
`RISCV:LE:64:default` with the `gcc` compiler specification per class, records
`language_selection: provider-pinned`, and refuses a caller-selected
`REA_GHIDRA_LANGUAGE_ID` or `REA_GHIDRA_COMPILER_SPEC_ID` that disagrees with the
pin without changing the requested override. An override that matches the pin is
accepted and recorded as `configured`.

The soft-float lane pins the same `RISCV:LE:32:default` language. In the 12.2
language definitions, every generic RV32 language, including the deprecated
soft-float `RV32I`, `RV32IC` and `RV32IMC` variants in
`old/riscv_deprecated.ldefs`, uses the same `riscv.ilp32d.sla` decoder; only the
compiler specification differs. The separate `RISCV:LE:32:AndeStar_v5` language
uses `andestar_v5.sla`. REA keeps the generic language and corrects the
calling convention instead.

## Calling conventions

Ghidra's generic RV32 compiler specification, `riscv32-fp.cspec`, models the
ilp32d ABI. Its default prototype passes `float` and `double` values in
`fa0`–`fa7` and returns them in `fa0`, and it passes a structure of one or two
floating-point members in floating-point registers. An ilp32 image passes all
of these in integer registers. Recorded on Ghidra 12.1.4 (no longer accepted);
not yet re-run on 12.2. With an ilp32 build of the fixture in
`tests/conformance/c/riscv-float-abi.c`, the stock model decompiled
`rea_riscv_abi_pick(1.5f, 2.5f, sel)` as
`rea_riscv_abi_pick(in_fa0,in_fa1,0x3fc00000)`. An ilp32f image passes `float` values as
ilp32d does, but `double` values in integer registers, and a structure of one
`float` and one integer in `fa0` and `a0`; the stock model joined that
structure into `a1:a0`.

### Source languages

Both policies model the C psABI. C++ follows it under the Itanium C++ ABI,
except for the classes in the [ilp32f limits](#ilp32f) that compilers pass
through a hidden pointer. Other languages need not follow it: Rust's default
ABI, for example, passes some small aggregates by reference or as two scalars
where the C psABI joins them into integer registers. Before either policy
installs its prototype, the script reads the image's DWARF once. It refuses
the image when a compile unit whose `DW_AT_language` is not C, C++ or assembly
defines a function with code, and names each such language with a count and an
example. A compile unit without `DW_AT_language` is refused the same way. This
applies to the ilp32 policy too, which until this check admitted such images.

The check reads only DWARF. Functions that no compile unit describes, such as
every function of a stripped image, or library code built without debug
information, are not checked and are taken to follow the C psABI. A limitation
states this on every session that applies a policy.

### Policy application and compatibility

After analysis on the pinned `RISCV:LE:32:default` language with `gcc`,
`ReaGhidraRiscvCallingConvention.java` derives the program-specific prototype
(`__rea_ilp32` or `__rea_ilp32f`) from the program's default prototype,
installs it through a Ghidra specification extension, and assigns it with
dynamic storage to every non-thunk function, every external function, and every
function definition. Thunks follow their targets.

The bridge reports the applied policy together with its function and definition
counts, and REA requires that report whenever the analysis profile commits
`riscv_calling_convention`. If a policy check fails—for example, if
`__rea_ilp32` or any function still places a value in a floating-point register
or fails to pass a 16-byte value by reference, or if `__rea_ilp32f` encounters a
signature shape it cannot place—the script refuses the policy and REA serves no
analysis of the image.

Double-float profiles keep their exact parameters, so their digests, sessions,
and snapshots are unchanged. Soft- and single-float profiles add
`riscv_elf.float_abi`, `riscv_elf.arch`, and `riscv_calling_convention`
alongside their lane ids; those fields are persisted in sessions, snapshots, and
Evidence once released. Any future change to a policy derivation must ship under
a new policy id (for example `ilp32-prototype-v2`) so that only that lane's
snapshots are invalidated. The design rationale and alternatives considered for
these policies are recorded in [#7477](https://github.com/morluto/rea/issues/7477).

### ilp32

Policy `ilp32-prototype-v1`, prototype `__rea_ilp32`. XLEN is 32 bits and no
floating-point register passes a value.

| Topic                      | psABI rule                                                                                                                                                                                        | `__rea_ilp32`                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Integer and pointer values | `a0`–`a7`, then the stack in 4-byte-aligned slots                                                                                                                                                 | The default integer and stack entries, unchanged                                                                                    |
| `float`                    | One integer register, or a stack slot                                                                                                                                                             | The `fa0`–`fa7` entries and the `float` rule are removed, so a `float` takes the next integer register                              |
| `double` and 8-byte values | A register pair with the low word in the lower register. Named arguments need no aligned pair. With one register left, the low word goes in `a7` and the high word on the stack                   | The default `join` rule with stack spill: Ghidra writes `a2:4,a1:4` for a pair and `Stack[0x0]:4,a7:4` for the split                |
| Aggregates up to 8 bytes   | One or two integer registers, laid out as in memory, also when every member is floating-point                                                                                                     | The homogeneous-float-aggregate rule is removed; the `join` rule applies                                                            |
| Aggregates over 8 bytes    | By reference: the caller passes the address of a copy                                                                                                                                             | The default rule that converts structures and unions of 9 bytes or more to pointers                                                 |
| Return values              | As the first argument of the same type: `a0`, or `a0` and `a1`. Larger values go to a caller buffer whose address is an implicit first argument in `a0`                                           | The `fa0`/`fa1` return entries and floating-point rules are removed; Ghidra's hidden-return fallback supplies the pointer in `a0`   |
| Variadic arguments         | The integer convention. A variadic argument with 8-byte alignment and size takes an aligned (even-numbered) register pair, or the stack; after the first stack argument, the rest go on the stack | The default variadic rule (`join` with alignment), unchanged                                                                        |
| Preserved registers        | `s0`–`s11` and `sp`; `gp` and `tp` are not allocated. No floating-point register is preserved                                                                                                     | The default preserved list without `fs0`–`fs11`, which join the killed-by-call list                                                 |
| Scalars over 8 bytes       | By reference (`long double` is 16 bytes), and returned through a caller buffer                                                                                                                    | A rule before the final join converts any value of 9 bytes or more to a pointer; a return that size already goes to a caller buffer |

Ghidra recovers the arguments of a variadic call from the registers the caller
writes, not from their types. A padding register that still holds an earlier
value can appear as an argument, and arguments after an unwritten register are
omitted.

### ilp32f

Policy `ilp32f-prototype-v1`, prototype `__rea_ilp32f`. ABI_FLEN and XLEN are
32 bits.

| Topic                                                                                  | psABI rule                                                                                       | `__rea_ilp32f`                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `float`                                                                                | `fa0`–`fa7` while one is free, then the integer convention                                       | The default `float` rule with the floating-point entries limited to 4 bytes. With no float register free, Ghidra falls back to the integer entries                                                                                                           |
| `double` and other scalars of 5 to 8 bytes                                             | The integer convention, as in ilp32                                                              | The floating-point entries take no value over 4 bytes, so the default `join` rule applies: `a2:4,a1:4` for a pair, `Stack[0x0]:4,a7:4` for the split                                                                                                         |
| Structure of one or two floats, after flattening                                       | One floating-point register per member when enough are free, otherwise the integer convention    | The default homogeneous-float-aggregate rule, which assigns every member or none                                                                                                                                                                             |
| Structure of one float and one integer, in either order                                | One floating-point and one integer register when both are free, otherwise the integer convention | New rule: a structure of up to 8 bytes takes `join_dual_class` with `fillalternate`. A 4-byte part that holds exactly one `float` takes the next float register and every other part the next integer register, all or nothing; else the `join` rule applies |
| Other structures of up to 8 bytes, such as three or more fields, a pointer, or a union | The integer convention                                                                           | Where the new rule would split one, the policy refuses the image (below)                                                                                                                                                                                     |
| Unions                                                                                 | Never flattened; the integer convention                                                          | The default rules                                                                                                                                                                                                                                            |
| Values over 8 bytes                                                                    | By reference                                                                                     | The default rules for structures and unions, and the rule every policy shares, which passes any other value of 9 bytes or more, such as `long double`, by reference                                                                                          |
| Return values                                                                          | As the first argument: `fa0`, `fa0` and `fa1`, or `fa0` and `a0`; by reference over 8 bytes      | The return entries are limited to 4 bytes and take the same structure rule; Ghidra's hidden-return fallback supplies the pointer in `a0`                                                                                                                     |
| Variadic arguments                                                                     | The integer convention, as in ilp32                                                              | The default variadic rule, unchanged                                                                                                                                                                                                                         |
| Preserved registers                                                                    | `s0`–`s11`, `sp`, and `fs0`–`fs11` for values of 32 bits or fewer                                | The default preserved list, including `fs0`–`fs11`                                                                                                                                                                                                           |

With the D extension the psABI preserves only the low 32 bits of `fs0`–`fs11`,
and Ghidra's model preserves the whole 64-bit registers, so the decompiler could
carry a wider value across a call. Admission refuses a `Tag_RISCV_arch` that
declares `d` or `zcd` with this ABI.

The psABI flattens nested structures and arrays and counts each named
bit-field, `_Bool`, `char` and enumeration as an integer field; LLVM treats a
pointer as neither a float nor an integer. Measured on Ghidra 12.1.4 against
the call sites of LLVM 19, the new rule places `struct { float; int; }`,
`struct { char; float; }`, a nested `float` beside an `int`, and a `float`
beside a bit-field in a float and an integer register. That holds both ways
round, when float or integer registers run out, for returns, and at indirect
calls. The same rule splits `struct { float; short; short; }`,
`struct { float; void *; }` and a `float` beside a union, which LLVM passes in
integer registers.

The prototype is the only thing that assigns storage. After assigning it,
`ReaGhidraRiscvCallingConvention.java` checks every parameter and return type
of every function signature and function-pointer type: it compares the storage
class `__rea_ilp32f` gives a first argument or a return value of that type with
the class the psABI gives it. The script refuses the policy when any signature
passes a type the prototype misplaces:

- a structure the new rule would split that the psABI passes in integer
  registers, such as the three above, a C++ structure with a nonzero array of
  empty classes, which GCC and Clang do not ignore when they flatten it, or a
  structure with a flexible array member, wherever it starts. Ghidra imports a
  trailing `[0]` array the same way, so a structure with one is refused too,
  although Clang passes it in a float register;
- a GNU vector of floats, which Ghidra imports as an array. It uses the integer
  convention, and C passes no array by value, so a parameter or return that
  Ghidra shows as an array is treated as a vector;
- a type the psABI places in float registers where the prototype cannot:
  `_Float16`, a packed structure whose `float` is not 4-byte aligned, or an
  over-aligned structure of more than 8 bytes;
- a value whose fields hold up to 8 bytes, whatever padding alignment adds, and
  include an untyped `byte`, `word`, `dword` or `qword`. Ghidra's DWARF import
  uses these for an encoding it does not map, so the policy cannot know the
  value's class. `float _Complex`, which takes two float registers, arrives as a
  `qword`. The stock double-float lanes show it as an integer.
- a value with a float whose structure has bytes that no member and no natural
  alignment padding account for. DWARF omits an unnamed bit-field of nonzero
  width, which the psABI still counts: Clang 19 passes
  `struct { float f; unsigned : 1; }` in `fa0` and `a0`, and a following `int`
  in `a1`, while Ghidra sees one float in 8 bytes. An over-aligned structure of
  up to 8 bytes looks the same and is refused too. An unnamed bit-field that
  fits inside a named bit-field's storage unit, or in padding that natural
  alignment adds, leaves no trace, so the check cannot see it: Clang 19 passes
  `struct { char c; unsigned : 1; float f; }` in `a0` and `a1`, and its DWARF
  lists only `c` and `f`, so the lane admits it with the float in `fa0`.
  Refusing every padded value with a float would also refuse common layouts
  such as `struct { char c; float f; }`, which takes `a0` and `fa0`. A C++
  empty class, which Ghidra imports as a one-byte structure without members,
  is its own storage, not an omitted field.
- a value whose float-register fields do not start the 4-byte parts the
  prototype reads them from. The psABI puts each flattened field at bit 0 of
  its own register, while the prototype gives each register a 4-byte part of
  the value as laid out in memory. GCC 14.2 and Clang 21.1.8 ignore a C++ empty
  class as a member, but it keeps its byte, so `struct { E e; char c; float f; }`
  passes `c` in bits 0-7 of `a0` although it lies in byte 1, where the
  prototype would read it from bits 8-15. A packed layout or a bit-field above
  bit 0 of its part moves a field the same way.
- a union parameter that may be a transparent union taking a float register.
  A transparent union passes as its first member, and DWARF does not record
  the attribute, so Ghidra sees an ordinary union in integer registers: Clang
  19 passes `union { struct { float f; } s; unsigned u; }` with
  `transparent_union` in `fa0`. Clang ignores the attribute when the first
  member is a floating-point type or another member differs from it in size or
  alignment, so `union { float f; uint32_t u; }` and unions with an integer
  first member are admitted. GCC 14.2 ignores the attribute whenever the first
  member would take a float register, so this also refuses some GCC images
  whose unions are placed right. Returns are not affected.
- a `float` parameter of an old-style (K&R) C definition, such as
  `float f(x) float x;`. Callers promote the argument to `double`, which Clang
  19 passes in integer registers, while DWARF still declares a `float` and
  only omits `DW_AT_prototyped`. Ghidra 12.1.4's DWARF import drops that
  attribute, so the script reads DWARF again for it, and only when a typed
  signature has a `float` parameter. C++ and other languages do not mark the
  attribute and are not checked.

A bit-field counts by its width, not its declared type, so a `float` beside
`unsigned long long b : 1` takes a float and an integer register. The check
treats typed functions and function-pointer types alike; Ghidra's decompiler
computes the storage at an indirect call from the prototype. A refusal counts
every misplaced signature and names up to eight, and REA then refuses the
session.

Not modelled:

- Ghidra 12.1.4 keeps no vector marker on an array, so a GNU vector inside a
  structure looks like `float[2]` and shows in `fa0` and `fa1`. GCC 14.2 and
  Clang 19 use integer registers. A limitation states this.
- Ghidra 12.1.4 resolves `_Atomic(float)` to `float`, so the policy places it as
  a `float`. That matches GCC 14.2, but Clang 19 uses integer registers, alone
  and in a structure. A limitation states this.
- A C++ class with a non-trivial copy constructor or destructor is passed
  through a hidden pointer, but Ghidra 12.1.4 keeps only its fields, so
  `struct N { float f; N(const N&); ~N(); }` shows as a `float` in `fa0`.
  Ghidra's DWARF importer does not read `DW_AT_calling_convention`, and GCC 14.2
  does not write it, so the policy cannot detect these signatures and does not
  refuse them. A limitation states this.
- Ghidra recovers the arguments of a variadic call from the registers the
  caller writes, as for [ilp32](#ilp32).

### ilp32d and lp64d

The double-float lanes use Ghidra's stock `riscv32-fp.cspec` and
`riscv64-fp.cspec` models unchanged. This page does not verify them. They lack
the float-and-integer structure rule above: the stock model joins
`struct { float; int; }` into integer registers.

## ISA declarations

The target reader finds the one `SHT_RISCV_ATTRIBUTES` section and reads
`Tag_RISCV_arch`, such as `rv32i2p1_m2p0_c2p0_zicsr2p0_zifencei2p0`. It
retains the string, the base and the extension names, or an unavailable reason
when the section is malformed, declares other vendors or scopes, or uses a
non-canonical string. A missing section or tag is recorded as absent.

Calling-convention lanes admit an image only when it declares an RV32I base
and only extensions the generic RV32 language implements with p-code in the
12.2 SLEIGH sources: `m`, `a`, `f`, `d`, `c`, `zicsr`,
`zifencei`, and the subset names toolchains record, `zmmul`, `zaamo`, `zalrsc`,
`zca`, `zcf` and `zcd`. Any other extension is refused. In particular, in those
12.2 sources:

- Ghidra decodes no Zcb, Zcmp or Zcmt instruction.
- Its bit-manipulation, cryptography and packed-SIMD files follow draft
  encodings and mark nearly every instruction unimplemented.
- Vendor extensions, such as Espressif's `xesploop`, `xespv` and `xespdsp`,
  decode only as custom-opcode placeholders.

ESP-IDF builds ESP32-C2 and C3 images as `rv32imc_zicsr_zifencei` and ESP32-C5,
C6, C61, H2 and H21 images as `rv32imac_zicsr_zifencei_zaamo_zalrsc`, all ilp32.
ESP-IDF 5.5 builds ESP32-H4 images as `rv32imafc_zicsr_zifencei` with the ilp32f
ABI. Those base strings are admitted. Builds that add `_zba_zbb_zbs`,
`_zcb_zcmp_zcmt` or an `xesp` extension are refused. That includes ESP-IDF
5.5's ESP32-P4 images, `rv32imafc_zicsr_zifencei_xesppie` with the ilp32f ABI,
until the decoding of the vendor PIE extension is verified. These images also
reserve their flash text's addresses; [load layout](#load-layout) states which
layouts the lane admits.

## Load layout

Section addresses are load addresses in an `ET_EXEC` image and fixed offsets
from the load base in a PIE, so an overlap does not depend on the base. The
target reader checks both for an executable section that shares allocated
addresses with another section; relocatable sections have no addresses yet. The check keeps at most 65,280 allocated sections
(`SHN_LORESERVE`); a table with more is refused like a table that cannot be
read. ESP-IDF builds such overlaps. For ESP32-C5, C6, C61, H2, H21
and H4, flash text and rodata share one virtual window from `0x42000020`, and
the linker script reserves the text's addresses in the rodata segment with the
NOBITS section `.flash_rodata_dummy`. For C5 and C61, a second NOBITS section,
`.ext_ram.dummy`, also reserves the text and rodata addresses for external RAM.
Ghidra 12.2's ELF loader, like 12.1.4's, resolves overlapping sections in
favour of the later one: the reservation takes the default address space and
`.flash.text` goes into an overlay space. Ghidra 12.2 also gives each section the
permissions of the first `PT_LOAD` that contains its address, so the reservation
can be marked executable; REA tells it from the code by its missing bytes. Ghidra's DWARF importer, its call-frame (FDE) processing
and references from other code and data resolve ELF virtual addresses in the
default space only. Without
preparation, code in that overlay gets no DWARF signature, local variables or
`DW_AT_noreturn` flag, each of its functions gets a one-byte shadow function in
the reservation, and pseudocode continues past calls to no-return functions
such as `esp_restart`.

When one NOBITS section starts at an executable PROGBITS section's address and
covers it, and no other section overlaps either, the lane commits both sections
to the analysis profile as `elf_load_preparation` (policy
`nobits-reservation-overlay-v1`). Before auto-analysis,
`ReaGhidraPrepareElfLoad.java` gives the code the default address space and the
reservation an uninitialized overlay instead:

- The file bytes and their offsets do not change. A new default-space block maps
  the code's file range, and the overlay maps no file bytes, so each file offset
  keeps one address.
- The loader's symbols and functions move with the code, and so do the
  references into it: its entry points and the loader's section-header
  reference. So does everything else in the code's overlay space, such as
  ESP-IDF's section-relative `_etext` just past the code's last byte. Ghidra
  pins absolute ELF symbols such as `_text_start`; they keep their addresses.
- Labels in the reservation, such as `_flash_rodata_dummy_start`, move into its
  overlay. They mark no entry points, because the reservation holds no code. An
  entry mark that Ghidra's loader gave such a label stays at its default-space
  address. Inside the code, Ghidra could start a function at that mark; REA
  neither removes nor checks it. No surveyed image has such a mark
  (source-derived).
- Flash code therefore has its ELF address, for example `0x42002ab6` rather than
  `.flash.text:0x42002ab6`.
- The reservation's overlay space takes the name that Ghidra's memory map gives
  an overlay block: `:` and whitespace become `_`, and a name that another
  address space already has gains `.1`, `.2` and so on. A reservation named
  `ram`, the RISC-V default space's name, therefore gets the space `ram.1`.
  Section names are display labels, so no name causes a refusal.

Before it reports `moved`, the script checks that no symbol or reference
remains in the code's old overlay space. It reports `canonical` when Ghidra
already loaded the code in the default space, which happens when the reservation
comes first in the section table. The `moved` report echoes both blocks the
script left, and `canonical` the code block: name, address, size, the code's
file offset, and the address space before and after. REA closes the session
unless each address, size and file offset is the committed section's, and the
spaces agree with the outcome: moved code goes from an overlay into the default
space and the reservation out of it, and canonical code stays in the default
space. Block names are display only and are not compared. The script refuses
any other memory map, and REA refuses the session with the mismatch. A refusal
also turns off Ghidra's headless auto-analysis, so Ghidra does not analyze a
program that REA discards; later pre-scripts and the bridge still run, so the
session reports the reason. If Ghidra
fails during the move, the session is also refused. Ghidra probably rolls back
the failed script's changes, its refusal included, so the reason may be missing
(inferred; not tested). Session Evidence states the preparation and its
outcome.

The lane refuses any other overlap that involves executable code. Examples are
two code sections at one address, a reservation that does not cover the code, a
third section that overlaps the reservation, and a second reservation such as
`.ext_ram.dummy`. The reason names the two sections that cause the refusal,
with their ranges. Overlaps between data sections only are outside this check,
and so are images without a section table, which Ghidra loads from their
program headers.

ESP-IDF v5.5.2's C5 and C61 builds declare `.ext_ram.dummy`, so this lane
refuses them. To analyze such a build, make a transformed copy without that
section header:

```sh
llvm-objcopy --remove-section=.ext_ram.dummy app.elf app-no-ext-ram-dummy.elf
```

The copy has the prepared shape. REA admitted and prepared such a copy of a
v5.5.2 C5 `hello_world` build; C61 copies were not tried. Evidence identifies
the copy, not the original image.

## Evidence

The lane identity is one of the lane ids above, and `riscv_elf` retains
`elf_class`, `byte_order`, `type`, and the raw `flags` alongside the read-only
booleans `float_abi_double`, `rvc_declared`, `rve_declared`, and
`tso_declared`. For PIE images, `riscv_elf` also records
`has_interpreter: true`, `load_model: "pie"`, and the expected default image
base (`expected_default_image_base: "0x10000"` for RV32, `"0x100000"` for RV64).
Soft- and single-float profiles also retain `float_abi` (`soft` or `single`),
the declared `arch` string, and `riscv_calling_convention`
(`ilp32-prototype-v1` or `ilp32f-prototype-v1`). Those fields report
declarations the header and attributes make, and the policy REA applied; none
of them is evidence of the original compiler or of instruction conformance.
Session Evidence states the prototype and how many functions and definitions
use it. An image that needs the [load layout](#load-layout) preparation also
commits `elf_load_preparation`: the policy, each section's index, name, address
and size, and the code's file offset.

## Verification and limits

Use the [supported Ghidra and JDK range](../getting-started/installation.md#ghidra).
On macOS the official release zip ships no host decompiler binary, so
`Decompiler/os/<platform>/decompile` and `sleigh` must come from your own build;
see that page and
[#7018](https://github.com/morluto/rea/issues/7018) /
[#7019](https://github.com/morluto/rea/issues/7019).

Run `npm run verify:ghidra:riscv` with that installation and a RISC-V-capable
Clang, LLD, LLVM readelf and LLVM objdump. The verifier acquires no tools and
never executes target code. Select installed tools explicitly when they are not
on `PATH`:

```sh
GHIDRA_INSTALL_DIR=/path/to/ghidra_12.2_PUBLIC \
JAVA_HOME=/path/to/jdk-25 \
REA_RISCV_CLANG=/path/to/llvm/bin/clang \
REA_RISCV_LLD=/path/to/lld/bin/ld.lld \
REA_RISCV_READELF=/path/to/llvm/bin/llvm-readelf \
REA_RISCV_OBJDUMP=/path/to/llvm/bin/llvm-objdump \
npm run verify:ghidra:riscv
```

The six non-ESP double- and soft-float fixtures passed on Ghidra 12.2 with JDK 25
on macOS arm64, using Homebrew LLVM and LLD 23.1.2; the ten-fixture double-,
soft-float and ESP lane passed on Ghidra 12.2 with JDK 25 on Linux x64; the
single-float fixtures have not been run on macOS arm64.

The lane builds fifteen fixtures from committed freestanding C and assembly sources:

- RV32 and RV64 double-float builds (`rv{32,64}imafdc`) of `riscv.c`,
  each linked as `ET_EXEC` and as a PIE.
- An RV32 soft-float build of `riscv-float-abi.c` with ESP32-C3's
  `-march=rv32imc_zicsr_zifencei -mabi=ilp32`, and an RV32 single-float build
  with ESP32-H4's `-march=rv32imafc_zicsr_zifencei -mabi=ilp32f`, both typed
  with DWARF.
- The same objects of each linked with `--strip-all`. Every allocated section
  keeps its address and bytes, so the typed build's symbols locate its
  functions.
- The single-float build with `REA_RISCV_ABI_UNMODELLED`, which adds a
  function that passes and returns a three-field structure, a `_Float16`
  function, a function-pointer type that passes the three-field structure,
  functions that pass a structure with a flexible array member, at the end of
  the structure and inside its padding, the second beside a structure whose
  unnamed bit-field DWARF omits, a function that passes a GNU vector, a
  function that passes `float _Complex` alone, in a structure and in an over-aligned structure, and, from `riscv-float-abi-empty.cpp`, a function that passes a structure with an
  array of one empty class, a function that passes an empty class beside a
  `char` and a `float`, and a caller that passes it known values. It also adds functions that pass a structure of one
  `float[2]`, a `float` beside a one-bit field of a 64-bit type, and two
  `float _Complex` fields, which the policy admits.
- The typed soft- and single-float builds with each C compile unit's
  `DW_AT_language` rewritten to Rust (`0x1c`). The assembly units keep theirs.
- An RV32 soft-float build of `riscv-esp-layout.c` with ESP32-C6's
  `-march=rv32imac_zicsr_zifencei -mabi=ilp32`, linked with
  `tests/conformance/esp/esp32c6-shared-window.ld`. As ESP-IDF does, it places
  `.flash.text` and the NOBITS `.flash_rodata_dummy` at `0x42000020`, with the
  absolute `_text_start` and `_text_end`, the section-relative `_etext` and the
  reservation's `_flash_rodata_dummy_start`.
- The same objects linked with `esp32c6-reservation-first.ld`, which puts the
  reservation before the code in the section table.
- The same objects linked with `esp32c6-reservation-named-ram.ld`, which names
  the reservation `ram`, as the default address space is named.
- The same objects linked with `esp32c6-edge-names.ld`, which names the
  reservation and a disjoint section like the preparation's temporary blocks.

PIE admission checks that the `PT_INTERP` declaration has an in-file range
large enough for a pathname byte and its terminator. The verifier checks the
real provider's load base and relocated probe bytes and checks refusal of
`ET_DYN` without `PT_INTERP`. REA never invokes the target interpreter.

Independent LLVM readelf observations establish ELF declarations,
`Tag_RISCV_arch` and symbol addresses. Public CLI and stdio MCP workflows verify
function enumeration, decompilation, pinned language/compiler identity, the
committed lane and policy, decoded probe bytes, global data, and direct calls.
They validate advertised MCP output schemas and both JSON representations, save
and reopen snapshots, and check unchanged source bytes and owned cleanup.

For the soft- and single-float builds the lane also checks:

- `fence.i` and `csrr` decode, as ESP32-C3's and H4's Zifencei and Zicsr
  declare, and `fmv.w.x` and `fmv.x.w` decode in the single-float build.
- An LLVM objdump reading of the callers finds each call-site word, in integer
  and float registers and on the stack, where the [ilp32](#ilp32) or
  [ilp32f](#ilp32f) policy puts it. The ilp32 calls cover an unaligned `double`
  in `a1`/`a2`, the `a7`/stack split, two floats in an integer pair, a large
  structure and a `long double` passed by reference (the pointed-to copies hold
  the source values), aligned variadic pairs, and an indirect call. The ilp32f
  calls add floats in `fa0`–`fa7`, two-float and float-and-integer structures
  both ways round, float registers running out, and an indirect call with a
  float-and-integer structure.
- `inspect_native_api` reports the policy's prototype with exactly that storage
  for the typed builds. For the stripped builds it reports the storage Ghidra
  infers from the registers each function uses. Their returns use the typed
  build's registers, or none when the result goes through caller memory; a
  single-float function that leaves a structure's float in `fa0` unchanged
  returns only the integer register it writes.
- The callers' pseudocode passes the source constants through that storage. In
  the soft-float builds it names no floating-point register; in the typed
  single-float build it names no register value that a prototype leaves out.
- Retained Evidence states the prototype outcome; the stripped builds have no
  function definitions.
- The unmodelled build is admitted by its headers, then refused over MCP and
  the CLI with the bridge's reason, which names its refused signatures and not
  the `float[2]` or bit-field functions.
  An LLVM objdump reading of its caller finds the empty-class structure's
  `char` at bit 0 of `a0`, its `float` in `fa0` and the following `int` in
  `a1`.
- The Rust-labelled builds are admitted by their headers, then refused over
  MCP by each policy with a reason that names Rust and `DW_AT_language 0x1c`.
  The unlabelled typed builds, with C, C++ and assembly units, are the
  controls.

For the ESP layout build the lane checks:

- The profile commits the two sections LLVM readelf reports.
- The load image maps `.flash.text` initialized and executable in the default
  space, with the reservation as an uninitialized overlay. Only the moved block
  maps the code's file bytes, and a `file-offset:` selector reaches the flash
  function at that offset.
- No entry point has an overlay address, and each flash function keeps its
  entry mark. `_text_start` and `_text_end` keep their addresses, `_etext` is
  at the code's end in the default space, and `_flash_rodata_dummy_start` is in
  the reservation's overlay.
- Every procedure keeps its ELF address, which selects it. The pseudocode of a
  flash function that ends by calling a `noreturn` function stops at that call.
  A flash function's pseudocode names its DWARF parameters, and an IRAM
  function's call reaches flash code.
- The outcome states the four moved functions, the entry points the load image
  reports in the code's range and the one overlay label. Retained Evidence
  keeps it, and the reopened snapshot lists the same procedures.
- A copy whose reservation is smaller than the code is refused over CLI and
  MCP, with the reservation named. `analyzeHeadless` with a code file offset one
  byte off makes the pre-analysis script refuse, and Ghidra then runs no
  auto-analysis.

The reservation-first build reports `canonical`: Ghidra loads its code in the
default space, and REA changes nothing. In the build whose reservation is named
`ram`, `analyzeHeadless` reports `moved`, with the reservation in the overlay
space `ram.1`. A copy of the RV32 double-float build
with a truncated section table is refused when REA opens it.

Header-mutated copies check admission. The RV32 double-float image relabelled as
soft-float (`e_flags` `0x1`), refused before that lane, is admitted through it
over CLI and MCP. Relabelled as single-float (`0x3`) it declares D and is
refused. The soft-float image relabelled as single-float lacks F and is refused;
RV64 soft- and single-float and unsupported high bits are refused with their
reasons. Failures retain the
diagnostic workspace; successful runs remove it and report the observed process
lineage.

Module tests cover admission, malformed headers, attribute sections and section
overlaps, the handshake, and the conformance checks against recorded LLVM and
Ghidra output.
Call-graph completeness, string inventories, dynamic linkage, Andes or RVE/TSO
images, big-endian targets, ilp32f images from GCC or ESP-IDF, and decoding
beyond the probes are **not** established by this lane.
