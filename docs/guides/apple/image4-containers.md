# Image4 containers

`inspect-artifact` and `extract-artifact` recognize an Image4 DER container
(`.im4p`, `.img4`, `.im4m` and the same bytes under any name) when the file
is a DER SEQUENCE whose first element is the IA5String `IM4P`, `IMG4` or
`IM4M`.

REA reads the container offline. It reports the payload type and description,
whether a keybag is present, and the manifest properties it can decode. It
does not decrypt payloads, expand compressed payloads, or check signatures
or certificates.

```sh
rea inspect-artifact ./kernelcache.im4p --json
rea extract-artifact ./kernelcache.im4p --json
```

## Payload (IM4P)

Root `format_metadata` has kind `apple-img4`. For an IM4P, `magic` is `IM4P`
and `payload` records:

| Field               | Meaning                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| `type`              | Four-character payload type, such as `krnl`, `ibot` or `sepi`                           |
| `description`       | Description string, or null when absent or not decodable as its string type             |
| `offset`, `length`  | Stored payload bytes inside the file                                                    |
| `compression`       | `none`, `unknown`, an LZFSE block magic (`bvx2`, `bvx1`, `bvxn`, `bvx-`), or `complzss` |
| `uncompressed_size` | Declared size, or the `complzss` header's big-endian size at offset 12                  |
| `payload_magic`     | LZFSE block magic or `complzss` sniffed from the stored bytes, otherwise null           |
| `encrypted`         | True when the payload carries a keybag, decoded or not                                  |
| `keybag_count`      | Number of keybag entries; 0 with no keybag, null when the keybag isn't decoded          |
| `keybag_types`      | Entry types that fit in 32 bits; null when the keybag isn't decoded                     |

Fields are read by position. After the type, description and payload, an
optional keybag OCTET STRING comes first, then an optional compression
SEQUENCE, then optional payload properties (`PAYP`) in context tag `[0]`,
which are reported but not decoded. A value outside its slot is reported as
an unknown field and never takes another field's role. The keybag's contents
are DER for a SEQUENCE of keybags, each an INTEGER type, an IV and a key. Keybag
initialization vectors and keys are not copied into metadata, limitations or
errors. A keybag that is empty, too large to decode, constructed, or not in
that layout is a limitation, and `encrypted` is still true so the payload is never treated
as plain bytes.

The compression element is SEQUENCE { INTEGER algorithm, INTEGER
uncompressed size }. Algorithm 1 is LZFSE and sets `compression` to `bvx2`
with the declared size. Payload magics `bvx2`, `bvx1`, `bvxn` and `bvx-`
agree with that algorithm. Another algorithm is a limitation and
`compression` follows `payload_magic`. A payload magic other than those
four, such as `complzss`, disagrees with algorithm 1: that is a limitation
and the declared algorithm is kept. An encrypted payload without a compression
field, or a declared algorithm other than 1 with no recognizable magic, has
compression `unknown`: encrypted bytes carry no readable magic, so REA does
not report them as uncompressed. LZFSE and `complzss` payloads are marked
compressed and returned as stored. REA does not expand them. A `complzss`
header stores a big-endian adler32 at offset 8 and the big-endian
uncompressed size at offset 12.

## Manifest (IM4M)

An IM4M file, or the manifest embedded in an IMG4, sets `manifest`:

| Field                    | Meaning                                                                                               |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `version`                | Unsigned decimal string, or null when absent or not that form. A version other than 0 is a limitation |
| `properties`             | Body properties such as `CHIP`, `BORD`, `ECID`, `CPRO` and `SDOM`                                     |
| `objects`                | Per-object names, `DGST` digests as hex, and other scalar properties                                  |
| `signature_size`         | Octet length of the signature                                                                         |
| `certificate_chain_size` | Content length of the certificate-chain element                                                       |

Integer properties are decimal strings. Booleans stay booleans. An octet
string of at most 64 bytes is lowercase hex. A longer octet string is
omitted and a limitation records its length. An integer wider than 16 bytes
is omitted the same way. The signature and certificate chain are not
validated.

## Restore info (IM4R)

An IMG4 may carry an `[1]` IM4R restore element. `restore_info.properties_present`
lists the four-character names, such as `BNCN`. `restore_info.values` is
`redacted`. The property values are not decoded.

## Entries

| Path               | Bytes                                         |
| ------------------ | --------------------------------------------- |
| `payload`          | Stored IM4P payload octet string              |
| `manifest.der`     | IM4M SEQUENCE, without the IMG4 `[0]` wrapper |
| `restore-info.der` | IM4R SEQUENCE, without the IMG4 `[1]` wrapper |

An encrypted payload is listed and `open` refuses it. `decoded` is false on
every entry. `unpacked` is false. A compressed payload reports
`compressedSize` equal to the stored length and `open` returns those stored
bytes. Extract the payload and pass an uncompressed image to the Mach-O
tools. Pass `manifest.der` back to `inspect-artifact` to read it as `IM4M`.

Indefinite length, a non-minimal length, a constructed string, trailing
bytes, and an unknown tag are limitations. `trailing_bytes` counts bytes
after a container whose end was found. When the root uses indefinite length
and is not bounded within 256 KiB, that end was not found and
`trailing_bytes` is null. Inventory coverage is `unknown`
when any limitation is present and `complete` otherwise. A truncated value
fails the read. Manifest and restore entries use PRIVATE-class tags whose
high-tag number is the entry's four-character code, such as `MANB`, `MANP`
or `BNCN`. A tag number whose code does not match the entry name is a
limitation. A high-tag form that encodes a number below 31, has a leading
zero octet, or needs more than five octets is malformed.

## Limits

Four representation ceilings refuse the file. This release has no runtime
override for them:

| Allowance                        | Limit | Unit       |
| -------------------------------- | ----- | ---------- |
| The Image4 DER depth allowance   | 32    | levels     |
| The Image4 DER element allowance | 4096  | elements   |
| The Image4 property allowance    | 256   | properties |
| The Image4 string allowance      | 4096  | bytes      |

Depth bounds DER recursion. The element allowance bounds TLV fan-out. A
payload octet string counts as one element and is not loaded to measure it.
The property allowance bounds retained manifest rows. The string allowance
bounds one IA5String, UTF8String or PrintableString retained as text.
Nested values wider than 256 KiB are walked by header instead of loaded
whole. A primitive value larger than 4096 bytes is never loaded, because
nothing that large is decoded, and at most 8 MiB of the file is loaded as
parsed trees for one inspection; past that, values are still walked and
checked by header. These caps are parse strategies, not refusals. A value
whose end cannot be found keeps its field's role: a keybag stays present, so
the payload stays encrypted, and the values after it are a limitation.
