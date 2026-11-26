# Qualcomm MBN images

`inspect-artifact` and `extract-artifact` recognize a legacy Qualcomm MBN
boot image (`sbl1.mbn`, `aboot.mbn`, `tz.mbn` and similar) by its header
contents, independent of the file name. The header has no magic number, so
REA claims it only when the version word is 3, 5 or 6, the image size
equals the sum of the payload region sizes, and the whole code region lies
inside the file. Version 3 also checks the signature and certificate-chain
pointers against the derived layout. Every signature-based format is tried first.

REA reads the header offline. It locates the signature and certificate
chain and reports their sizes; it does not verify signatures, check
certificates, recompute hashes, or bypass secure boot.

```sh
rea inspect-artifact ./sbl1.mbn --json
rea extract-artifact ./sbl1.mbn --json
```

## Header fields and regions

Root `format_metadata` has kind `qualcomm-mbn` and layout `legacy`. The
header records the image ID, version, image size, code size, and OEM
signature and certificate-chain pointers and sizes.

| Version | Header size | Version-specific fields                                                  |
| ------- | ----------- | ------------------------------------------------------------------------ |
| 3       | 40 bytes    | Flash source offset (`image_source`) and destination at offsets 8 and 12 |
| 5       | 40 bytes    | QTI signature and certificate-chain sizes at offsets 8 and 12            |
| 6       | 48 bytes    | Version 5 fields plus QTI and OEM metadata sizes at offsets 40 and 44    |

In version 3, `image_source` reports the raw flash source offset from header
offset 8, and `image_source_name` is `null` when not independently established
(REA does not map `image_src` to a boot-device enum). In version 6, QTI and OEM
metadata follow the header and precede the code. In versions 5 and 6, the QTI
signature and certificate chain follow the code and precede the OEM signature
and certificate chain. The image size counts all payload regions and excludes
the header. Fields absent from a version are reported as null.

`header.ranges` gives the file offset and length REA derived for each
region. The regions are listed as occurrences:

| Path                             | Bytes                          |
| -------------------------------- | ------------------------------ |
| `header.bin`                     | the version-specific header    |
| `code.bin`                       | the code region                |
| `signature.bin`                  | the signature                  |
| `certificate-chain.bin`          | the certificate chain          |
| `metadata0.bin`, `metadata1.bin` | version 6 QTI and OEM metadata |

The QTI signature and certificate chain are available as `qti-signature.bin`
and `qti-certificate-chain.bin` when present.

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
rows and `omitted_segment_hashes` counts the rest when the complete table is
readable. The full table is available as `hash-table.bin`. ELF regions must fit
within both the program header’s `p_filesz` range and the file. A region that
crosses either bound remains in declared metadata with a range limitation and
is omitted from extraction.

A program header count of 65535 (ELF extended numbering), an entry size
that is not the ELF class size, or a table past the file end leaves the
hash segment unknown, and the file stays ELF. A hash segment header that
cannot be decoded, an MBN header cut short by the segment size or
the file end, further hash segments, and a code size that does not match
a supported digest size (32, 48, or 20 bytes) times the program header
count are limitations with `unknown` coverage; when no digest size
matches the program header count, `hash_size` and `hash_count` are
reported as `null`.

## Verification scope

Source tests cover synthesized version 3, 5, and 6 legacy headers,
headers whose sizes or pointers disagree, a truncated signature range,
header-sized files without their code region, ELF32 images with and without
a hash segment through inventory and extraction, a truncated hash-segment
signature, a hash segment that is not an MBN header, program header count
65535, a wrong entry size, a table past the file end, several hash segments,
version 6 hash headers cut short, a version 5 segment with a reduced `p_filesz`,
and a hash count that does not match. Tests use synthetic images.
