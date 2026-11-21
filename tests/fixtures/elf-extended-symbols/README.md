# Extended ELF symbol section control

The generator writes inert assembler sources with 65,516 padding sections.
Assemble and inspect them; never load or execute the resulting objects.

```sh
out=$(mktemp -d)
python3 tests/fixtures/elf-extended-symbols/generate.py "$out"
as --32 "$out/extended-32.s" -o "$out/extended-32.o"
as --64 "$out/extended-64.s" -o "$out/extended-64.o"
clang-19 --target=aarch64_be-linux-gnu -c "$out/extended-aarch64be.s" -o "$out/extended-aarch64be.o"
npm run build:cached
for file in "$out"/*.o; do
  readelf -sW "$file"
  readelf -SW "$file"
  node scripts/rea.mjs inspect-native-initializers "$file" --json
done
```

Executed with GNU assembler/readelf 2.44 and Debian Clang 19.1.7 on Linux
x86-64. The two GNU objects place `high_ctor` in actual section 65521,
represented by `SHN_XINDEX` plus a companion entry, rather than raw `SHN_ABS`.
The Clang AArch64 big-endian object uses actual section 65520 and also exercises
a near-budget symbol table. All three recovered the target section and file
offset matching readelf, preserved the ordinary `local_ctor`, and kept source
SHA-256 unchanged. The pre-fix parser lost the high constructor's section and
file offset in all three controls.

Portable tests generate sparse ELF32/64 section directories without invoking
an assembler. They cover CLI/stdio MCP, malformed companions, independent
ordinary symbols, and the distinction between special markers and actual
equally numbered sections. No production application or target execution was
tested. Compiler-produced binaries are not committed.
