# RISC-V initializer producer control

`witness.c` is cross-compiled for inspection only. Do not load or execute the
resulting objects or shared libraries. Portable CLI/MCP tests use the synthetic
`RiscvInitializers.fixture.ts`; this independent producer checks the ABI facts
behind those tests without requiring a compiler in CI.

From the repository root, select Clang and LLD and create an owned output directory:

```sh
CLANG=clang-19
LD_LLD=ld.lld-19
out=$(mktemp -d)
npm run build:cached
for bits in 32 64; do
  if [ "$bits" = 32 ]; then abi=ilp32d; else abi=lp64d; fi
  "$CLANG" --target=riscv${bits}-linux-gnu -march=rv${bits}gc -mabi="$abi" \
    -nostdlib -ffreestanding -fPIC -c tests/fixtures/riscv-initializers/witness.c \
    -o "$out/rv${bits}.o"
  "$LD_LLD" -shared --hash-style=both "$out/rv${bits}.o" -o "$out/rv${bits}-rela.so"
  "$LD_LLD" -shared --hash-style=both -z pack-relative-relocs \
    "$out/rv${bits}.o" -o "$out/rv${bits}-relr.so"
  for file in "$out/rv${bits}.o" "$out/rv${bits}-rela.so" "$out/rv${bits}-relr.so"; do
    readelf -rW -sW "$file"
    node scripts/rea.mjs inspect-native-initializers "$file" --json
  done
done
```

Executed with Debian Clang/LLD 19.1.7 and GNU readelf 2.44 on Linux x86-64.
All six files reported four entries: two constructors and a finalizer matched
the producer's `local_ctor`/`defined_ctor` symbol coordinates; `external_ctor`
remained an unresolved import. Input SHA-256 values were unchanged after inspection.
The shared objects used `R_RISCV_RELATIVE` and `R_RISCV_32`/`R_RISCV_64`, or
RELR plus the absolute records. The ET_REL objects used section-relative
absolute records. Before the change, both shared-object encodings on both
word sizes returned four unknown addresses and incomplete coverage.

Expected resolutions in file order:

| Input              | Constructors                                      | Finalizer       |
| ------------------ | ------------------------------------------------- | --------------- |
| ET_REL             | symbol addend, symbol addend, unresolved import   | symbol addend   |
| RELA shared object | relative addend, symbol addend, unresolved import | relative addend |
| RELR shared object | RELR, symbol addend, unresolved import            | RELR            |

This control does not establish behavior on a RISC-V host or in a dynamic
loader, nor does it verify that a listed address executes. TLS and indirect
resolver non-resolution, COPY extents and unknown kinds have separate source
tests; these six producer files do not exercise those relocation types.
