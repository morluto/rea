# i386 REL initializer addend oracle

`constructor.s` is an independent GNU assembler/linker producer for the facts
carried by `../elf32RelAddends.ts`. Production is currently correct; the CLI
regression protects its word-width handling against future changes.

Reproduce with GNU binutils 2.44 (no execution of either output):

```sh
as --32 constructor.s -o /tmp/constructor.o
ld -m elf_i386 --entry=marker -Ttext=0x1000 -o /tmp/constructor.elf /tmp/constructor.o
readelf --wide --relocs --symbols --hex-dump=.init_array /tmp/constructor.o
readelf --wide --symbols --hex-dump=.init_array /tmp/constructor.elf
```

Observed in the object:

```text
Offset     Info    Type       Sym. Value  Symbol's Name
00000000  00000101 R_386_32    00000001   marker
00000004  00000101 R_386_32    00000001   marker
00000008  00000101 R_386_32    00000001   marker

marker: value 00000001, size 2, FUNC, GLOBAL, .text
.init_array: ffffffff 01000000 00000000
```

The object dump contains **unapplied** REL addends. With `.text` linked at
`0x1000`, GNU ld gives `marker` value `0x1001` and writes `.init_array` bytes
`00100000 02100000 01100000`: addresses `0x1000`, `0x1002`, `0x1001`.
Subtracting that section base gives the object's section-relative target offsets
`0`, `2`, `1`. In particular, the in-place `ffffffff` word is not an extra
4 GiB in the resolved pointer.

The portable carrier reuses the repository's ELF32 fixture layout. It preserves
these relocation records, symbol facts, raw words, and three text bytes; it is
not a byte-for-byte GNU object golden. Its text is stored at file offset `0x80`,
so CLI Evidence must retain target file offsets `0x80`, `0x82`, `0x81`. No
compiler, linker, binary fixture, or native i386 runtime is required by CI.

The CLI test checks all three rows, the zero-addend symbol-name control, the
artifact digest, and unchanged source bytes. Removing only the symbol-plus-addend
`BigInt.asUintN` in `ElfInitializerSymbols.ts` leaves the prior 125 initializer
tests passing, but this test fails: offset zero becomes `0x100000000` with a null
file offset. Restoring production makes the combined 126 tests pass. This does
not establish general GNU linker parity or native Windows/macOS execution.
