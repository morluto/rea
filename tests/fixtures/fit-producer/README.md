# U-Boot FIT address producer

`oracle.json` records three complete, inert FIT carriers produced by **U-Boot
mkimage/dumpimage 2025.01** and **DTC/libfdt 1.7.2**. The embedded, aligned
`data-offset`, and absolute `data-position` forms carry identical source payloads
and address declarations. No REA fixture builder writes or patches these files.

Each contains two images with nonzero address high words (one with the unsigned
64-bit top bit set), plus a one-cell control. Both wide addresses exceed 2^53.
`fdtget` independently reads the emitted load/entry property cells; the producer
checks them against the ITS declarations and U-Boot's printed addresses.
`dumpimage` extracts every payload, which must equal its input before its size
and SHA-256 enter the oracle. Each image also has SHA-256 and CRC32 hash nodes.

Current REA production decodes these files correctly. The protection gap is
specific: changing `FitStructure.fitAddress`'s accumulation from
`(value << 32n) | BigInt(...)` to `0n | BigInt(...)` drops earlier cells. All 86
existing tests across the structure, reader, public CLI, stdio MCP, and artifact
comparison suites still pass: their valid two-cell address has a zero high word.
The new compiled CLI regression fails for all three producer storage forms at
the load/entry metadata assertions. Restoring the original source restores the
expected addresses. This is a test contribution, not a production fix.

## Reproduce

With the pinned tool versions available on PATH:

```sh
python3 tests/fixtures/fit-producer/produce.py --check
```

Or select the directory holding `mkimage`, `dumpimage`, `dtc`, and `fdtget`:

```sh
python3 tests/fixtures/fit-producer/produce.py --tool-dir /path/to/bin --check
```

`fdtget` must be able to load its matching libfdt. The recorded run used local
extractions of official Debian packages, without installing system software:

- [u-boot-tools 2025.01-3+deb13u1](https://deb.debian.org/debian/pool/main/u/u-boot/u-boot-tools_2025.01-3+deb13u1_amd64.deb)
- [device-tree-compiler 1.7.2-2+b1](https://deb.debian.org/debian/pool/main/d/device-tree-compiler/device-tree-compiler_1.7.2-2+b1_amd64.deb)
- [libfdt1 1.7.2-2+b1](https://deb.debian.org/debian/pool/main/d/device-tree-compiler/libfdt1_1.7.2-2+b1_amd64.deb)

The script runs tools with argument arrays in a fresh private temporary
directory and fixes `SOURCE_DATE_EPOCH=1700000000`. `--check` compares every
complete carrier byte and independently read fact with the committed record;
omit it only to regenerate the record. Deflate/base64 is fixture transport;
the test bounds inflation and verifies the full carrier size and SHA-256.
No tool download, target execution, boot, signature verification or runtime
address admission occurs in the tests. No real firmware device or native
Windows/macOS behavior is established by this oracle.
