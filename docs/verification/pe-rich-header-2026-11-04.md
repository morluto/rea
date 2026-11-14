# PE Rich header verification - 2026-11-04

All runs used Windows 11 (10.0.26200) x64 and Node 24.22.1. No target was
executed.

## Oracle

The oracle is pefile **2024.8.26**, installed without dependencies into a
separate virtual environment. Its `pefile.py` SHA-256 is
`0d0eb68f0f169182613dc64b3ab50b20855508c1c1d2faafe8fccf23edb6a345`.
`parse_rich_header` reads from file offset `0x80` up to the first `Rich`
marker and warns when the first DWORD there is not `DanS`.

## Installed images

```sh
REA_PEFILE_PYTHON=<python with pefile> node scripts/verify-pe-rich-header.mjs \
  "C:\Windows\System32" "C:\Program Files" "C:\Program Files (x86)"
```

The script walked 17,896 `.exe`, `.dll`, `.sys`, `.ocx`, `.cpl`, `.efi` and
`.scr` files with `max_file_bytes` at its 512 MiB ceiling. A file is left out
of the comparison only on pefile's own result: pefile warned that `0x80` is not
`DanS`, or REA found a footer before `0x80`, where pefile never looks. Every
other state difference counts as a disagreement and fails the run. A file REA
rejects fails the run too, unless pefile also rejects it.

| Result                                               | Files  |
| ---------------------------------------------------- | ------ |
| Rich header present                                  | 10,915 |
| Checksum reproduces the stored key                   | 10,901 |
| Checksum does not reproduce the key                  | 14     |
| No Rich footer before the PE signature               | 6,980  |
| Malformed record                                     | 0      |
| Rejected by REA and pefile (a 0-byte `eqnedt32.exe`) | 1      |
| Same key and entries as pefile, or both absent       | 17,890 |
| Different from pefile                                | 0      |
| Outside pefile's `0x80` layout assumption            | 5      |

The 14 checksum mismatches are seven NVIDIA driver files in one DriverStore
package, three `vk*.sys` drivers, three Riot Vanguard executables, and
`tcblaunch.exe`. Their entries still match pefile wherever pefile's layout
assumption holds.

The five images outside pefile's assumption:

| Image                    | `DanS`   | Entries | Checksum | pefile                                    |
| ------------------------ | -------- | ------- | -------- | ----------------------------------------- |
| `WeGameDriverXP.sys`     | `0x200`  | 5       | matches  | 53 value pairs, "not in Microsoft format" |
| `vkdpi.sys`              | `0x58`   | 7       | differs  | "not in Microsoft format"                 |
| `vktap.sys` (two copies) | `0x58`   | 7       | differs  | "not in Microsoft format"                 |
| `tcblaunch.exe`          | `0x2D20` | 7       | differs  | "not in Microsoft format"                 |

`tcblaunch.exe` 10.0.26100.9711 has a custom 11 KB DOS stub that is itself a
PE image. The stub's own record sits at `0xC0`, and its checksum reproduces
its key when summed from the stub image's start at `0x40`. The outer record
at `0x2D20` is the one reported.

## Synthetic fixtures

Parser tests build PE32 and PE32+ images and compute the expected key with a
separate BigInt checksum. They cover zero entries, nonzero padding, a stub
byte changed after linking, a wrong stored key, a footer whose key would
overlap the PE signature, an unaligned marker, an earlier footer embedded in
the stub, a missing `DanS`, a partial entry, the entry budget, a 2 MiB stub,
cancellation, and a non-PE input.
