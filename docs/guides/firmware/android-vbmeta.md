# Android Verified Boot vbmeta images

`inspect-artifact` and `extract-artifact` recognize a standalone Android
Verified Boot `vbmeta.img` by the four-byte `AVB0` magic at offset 0,
independent of the file name. They read the 256-byte header and its descriptor
table without verifying a signature or digest, and without modifying the file.
`vbmeta_system.img` and `vbmeta_vendor.img` use the same layout.

An `AVBf` footer at the end of a boot image is a different structure. The boot
image reader records that footer's vbmeta offset and size and does not decode
the embedded vbmeta. Footers on other partition images are out of scope.

```sh
rea inspect-artifact ./vbmeta.img --json
rea inspect-artifact ./vbmeta.img --detail summary \
  --evidence_output vbmeta.evidence.json --json
rea extract-artifact ./vbmeta.img --json
```

With MCP, `open_binary` reports an archive with unknown executable
architecture. `inspect_artifact` with `detail: "summary"` retains the complete
Evidence. Use `inspect_analysis_view` and its `parent_evidence_id` for exact
logical paths and selected fields.

## Header

Root `format_metadata` (`kind: "android-vbmeta"`) records the required libavb
major and minor, the algorithm type and name (`NONE`, `SHA256_RSA2048`,
`SHA256_RSA4096`, `SHA256_RSA8192`, `SHA512_RSA2048`, `SHA512_RSA4096`,
`SHA512_RSA8192`, or `UNKNOWN`), the authentication and auxiliary block sizes,
and the hash, signature, public key, public key metadata, and descriptor
ranges. Those ranges are the header's own block-relative values. It also
records the rollback index and rollback index location, header flags, the
release string, the image size, and any trailing bytes after the declared
image. The rollback index is an unsigned 64-bit counter and is reported as a
decimal string, so values past 2^53 keep every digit.

`flag_names` includes `HASHTREE_DISABLED` and `VERIFICATION_DISABLED` when
those bits are set, plus a hexadecimal token for any other bit. An unknown
algorithm name keeps the raw type and adds a limitation. A required libavb
major other than 1 is decoded with the version-1 layout as an assumption. A
limitation marks its header fields, descriptors, and child ranges as
unconfirmed.
Non-zero header reserved bytes add a limitation. `signatures_verified` is
always `false`.

The release string is target-derived. Invalid UTF-8 stays null and
`release_string_bytes_hex` keeps the full 48-byte field. As in libavb, the
field's final byte (file offset 175) must be NUL; otherwise the header is
refused as malformed at that offset.

## Descriptors

Each descriptor keeps its tag, its `num_bytes_following`, and its file
`offset`. Known tags are:

- `PROPERTY`: key and value. Invalid UTF-8 stays null with the raw hex.
- `HASHTREE`: partition name, dm-verity version, image size, tree offset and
  size, data and hash block sizes, FEC roots, offset and size, hash algorithm,
  salt, root digest, and flags (`DO_NOT_USE_AB`, `CHECK_AT_MOST_ONCE`).
- `HASH`: partition name, image size, hash algorithm, salt, digest, and flags
  (`DO_NOT_USE_AB`).
- `KERNEL_CMDLINE`: flags (`USE_ONLY_IF_HASHTREE_NOT_DISABLED`,
  `USE_ONLY_IF_HASHTREE_DISABLED`) and the command-line bytes.
- `CHAIN_PARTITION`: rollback index location, partition name, flags
  (`DO_NOT_USE_AB`), and the SHA-256 and size of the descriptor's public key
  bytes. As in libavb, a rollback index location of 0 is malformed and stops
  the descriptor walk at that field.

The hashtree `image_size`, `tree_offset`, `tree_size`, `fec_offset`, and
`fec_size`, and the hash `image_size`, are unsigned 64-bit values that describe
another partition. They are reported as decimal strings, so values past 2^53
keep every digit.

An unknown tag is kept as tag, size, and file offset. Its tag is a decimal
string because the field is an unsigned 64-bit value. One limitation covers
every unknown descriptor: it gives their count, names up to eight distinct
tags, and counts the tags it omits. To recover an unknown payload, read `num_bytes_following` bytes from the
original carrier starting at the reported descriptor offset plus 16 bytes.

The summary view uses kind `android-vbmeta-summary`. It keeps the header
scalars and replaces the descriptor array with `descriptor_count`,
`property_count`, `hashtree_count`, `hash_count`, `kernel_cmdline_count`,
`chain_partition_count`, and `unknown_count`. The complete Evidence keeps
every descriptor.

## Children

When the range is non-empty, extraction writes:

| Path                   | Bytes                                   |
| ---------------------- | --------------------------------------- |
| `authentication_block` | the whole authentication block          |
| `public_key`           | the auxiliary-block public key          |
| `public_key_metadata`  | the auxiliary-block public key metadata |

`public_key_sha256` on the root is the SHA-256 of that public key, or null
when the key is empty. A chain-partition descriptor reports the SHA-256 of
its own key bytes. Matching digests indicate that the parent image declares the
same key material in both fields. The reader does not inspect the chained
partition or verify either signature.

## Limits

The reader admits an authentication block of at most 64 KiB, an auxiliary
block of at most 2 MiB, and a descriptor table of at most 1 MiB and 4,096
descriptors. Block sizes must be multiples of 64. A descriptor's
`num_bytes_following` must be a multiple of 8, and every range must fit its
block before those bytes are read. A declared image that ends past the file is
`truncated`. A structural mismatch is `invalid_request`. A ceiling is
`truncated` with `details.reason` `limit`. These refusals do not produce an
empty successful inventory.

A malformed descriptor does not refuse the image. The walk stops there:
`descriptors` keeps the descriptors decoded before it, and
`descriptor_failure` records the failure `kind`, `detail`, `field`, the file
`offset` of the failing field, the `descriptor_offset`, and the
`unexamined_bytes` left in the table. A limitation repeats the stop point.
Because part of the table was not examined, inventory coverage is `unknown`
rather than `complete`, and the summary descriptor counts cover only the
decoded prefix. The header and the stored-range children are still reported.
`descriptor_failure` is null when every descriptor decodes. Coverage is
`complete` only when every descriptor decodes and the major version is
supported. An unsupported major version leaves coverage `unknown` even when
every descriptor decodes.

## Verification scope

Signatures, hashes, and hashtree digests are recorded and not verified.
Release strings, property values, kernel command lines, and partition names
are target-derived and untrusted. Nothing is signed or modified. AVB footers
on partition images other than boot images are out of scope.
