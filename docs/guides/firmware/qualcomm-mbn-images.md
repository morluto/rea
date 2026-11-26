# Qualcomm MBN images

`inspect-artifact` and `extract-artifact` recognize a legacy Qualcomm MBN
boot image (`sbl1.mbn`, `aboot.mbn`, `tz.mbn` and similar) by its header
contents, independent of the file name. The header has no magic number, so
REA claims it only when the version word is 3, 5 or 6, the image size
equals the sum of the region sizes, the signature and certificate-chain
pointers follow the code region, and the whole code region lies inside the
file. Every signature-based format is tried first.

REA reads the header offline. It locates the signature and certificate
chain and reports their sizes; it does not verify signatures, check
certificates, recompute hashes, or bypass secure boot.

```sh
rea inspect-artifact ./sbl1.mbn --json
rea extract-artifact ./sbl1.mbn --json
```

## Header fields and regions

Root `format_metadata` has kind `qualcomm-mbn` and layout `legacy`. Its
`header` records the declared words: `image_id`, `version`,
`image_source` (with `image_source_name` when the value is a known boot
device), `image_destination`, `image_size`, `code_size`, the signature and
certificate-chain pointers and sizes and, for the 80-byte version 5 and 6
header, the two metadata region sizes and pointers. Version 3 uses the
40-byte header and its metadata fields are null.

`header.ranges` gives the file offset and length REA derived for each
region. The regions are listed as occurrences:

| Path                             | Bytes                                   |
| -------------------------------- | --------------------------------------- |
| `header.bin`                     | the 40- or 80-byte header               |
| `code.bin`                       | the code region                         |
| `signature.bin`                  | the signature                           |
| `certificate-chain.bin`          | the certificate chain                   |
| `metadata0.bin`, `metadata1.bin` | version 5 and 6 metadata, when declared |

A region that extends past the end of the file is not listed and is not
clamped. Its range is reported as a limitation, for example
`signature range 240+256 exceeds the 400-byte file`, and inventory coverage
is `unknown`.

## ELF images

A modem or TrustZone ELF image that carries a Qualcomm hash segment is
inventoried and extracted as `qualcomm-mbn`: REA finds the first program
header whose `p_flags` bits 24-26 equal 2. Binary target resolution still
reads the file as ELF, so native analysis is unchanged. An ELF image
without a hash segment stays an ELF artifact.

`inspect-artifact` reads the MBN header at the hash segment's file offset
and reports layout `elf` with the ELF class, byte order, machine, program
header count, hash segment location, hash size (SHA-256, SHA-384 or SHA-1,
chosen by the code size and program header count), hash count and the file
offset of each program header's hash. `segment_hashes` lists the first 64
rows and `omitted_segment_hashes` counts the rest; every hash is in the
listed `hash-table.bin` region.

A program header count of 65535 (ELF extended numbering), an entry size
that is not the ELF class size, or a table past the file end leaves the
hash segment unknown, and the file stays ELF. A hash segment header that
cannot be decoded, a version 5 or 6 header cut short by the segment size or
the file end, further hash segments, and a hash count that differs from the
program header count are limitations with `unknown` coverage.

## Verification scope

Source tests cover synthesized version 3 and version 6 legacy headers,
headers whose sizes or pointers disagree, a truncated signature range,
header-sized files without their code region, ELF32 images with and without
a hash segment through inventory and extraction, a truncated hash-segment
signature, a hash segment that is not an MBN header, program header count
65535, a wrong entry size, a table past the file end, several hash segments,
version 6 hash headers cut short, and a hash count that does not match. No vendor image
was used.
