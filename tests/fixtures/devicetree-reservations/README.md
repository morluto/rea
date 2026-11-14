# libfdt reservation oracle

The existing DTB fixtures and real-dtc verifier use the reservation
`address=0x80000000, size=0x1000`. They cannot distinguish a 64-bit read from
a read of only the low 32 bits. Reservation addresses are physical addresses,
not offsets into the small DTB file.

`produce.c` uses upstream **libfdt 1.8.1** to create a tree and add two
reservations. `fdt_get_mem_rsv` independently reads both words back and checks
them against the C `uint64_t` inputs:

| Address       | Size          |
| ------------- | ------------- |
| `0x120000000` | `0x2000`      |
| `0x10000000`  | `0x100002000` |

The first exercises an address above 4 GiB; the second has a size above 4 GiB.
The producer validates the tree with `fdt_check_full` under wire versions 17
and 16. The v16 witness changes the version of the packed tree; these are not
two independent DTS compilations. Neither the firmware nor a board is executed.

`oracle.json` retains the decoded facts, producer-source SHA-256 and exact
reservation table bytes, including the zero terminator. The public CLI/MCP
test puts these bytes into the existing synthetic DTB carrier and shifts its
block offsets. It does not re-encode the 64-bit words, commit a binary, or claim
to exercise the producer's entire file layout in CI. The test checks both wire
versions, artifact identity, record offsets, the terminator-derived count,
unchanged source bytes and agreement between CLI and stdio MCP.

## Reproduce

Use the official [dtc 1.8.1 archive](https://www.kernel.org/pub/software/utils/dtc/dtc-1.8.1.tar.xz),
SHA-256 `23526015a6f1550e0541a53fe7acea1b5a11e3697cdf3a3bdc076abc38f6045d`.
Building only libfdt does not require the DTS parser's flex/bison tools.

```sh
tar -xf dtc-1.8.1.tar.xz -C /tmp
make -C /tmp/dtc-1.8.1 libfdt/libfdt.a NO_PYTHON=1 NO_YAML=1
python3 tests/fixtures/devicetree-reservations/produce.py \
  --libfdt-root /tmp/dtc-1.8.1 --check
npm run test:focused -- tests/acceptance/devicetreeReservationOracle.test.ts
```

The producer was run on Linux x86-64 with GCC 14.2.0. `--keep-generated DIR`
optionally keeps the complete libfdt-generated blobs for local inspection.
Normal tests require neither a compiler nor libfdt, and do not download anything.

Current production is correct. On the qualification base, replacing both
reservation reads with `BigInt(bytes.readUInt32BE(cursor + 4))` and
`BigInt(bytes.readUInt32BE(cursor + 12))` left all 37 existing parser, service,
CLI and MCP tests passing. This new public case failed on the lost address and
size high words. Restore the parser and rebuild before normal verification;
the mutation is not part of this contribution.
