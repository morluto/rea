# GCC inline-variable export facts

`inline.cpp` declares ordinary and thread-local inline C++17 variables. GCC
14.2 emits `STB_GNU_UNIQUE` for both. Compiling the same source with
`-fno-gnu-unique` emits `STB_WEAK` instead. No library is loaded or executed.

`produce.py` compiles both variants in a temporary directory. It reads the
numeric binding/type from each actual ELF `st_info` byte, while GNU readelf
independently supplies the named classifications, symbol values and sizes.
The oracle records the tool versions, flags, source digest and observed OS ABI.
The captured toolchain is g++ 14.2.0 (Debian 14.2.0-19), GNU readelf 2.44,
on Linux x86-64 producing little-endian ELF64.

Regenerate or verify with those tools (Python standard library only):

```sh
python tests/fixtures/elf-gnu-unique/produce.py
python tests/fixtures/elf-gnu-unique/produce.py --check
```

The public CLI regression puts these selected symbol facts in the existing
portable ELF carrier. It tests object/TLS binding preservation, the weak
negative control and source-digest Evidence without needing GCC in CI or
committing a binary. It does **not** qualify the compiler's complete ELF layout
or a native loader in CI. Current production classifies these bindings
correctly; this fixture protects that existing behavior.
