# PE Authenticode certificate tables

`inspect_pe_certificates` / `inspect-pe-certificates` answers whether one
selected local PE32/PE32+ image declares an `IMAGE_DIRECTORY_ENTRY_SECURITY`
table, which `WIN_CERTIFICATE` entries that table stores, and which PKCS#7
signer and X.509 fields those entries carry. It reads the file without
executing it and does not require a Windows SDK, catalog file, or disassembler.

```bash
rea inspect-pe-certificates /absolute/path/to/application.exe --json
```

The CLI resolves relative paths against the caller's working directory. MCP
and the advertised input schema require an absolute filesystem path and
preserve that exact selection:

```json
{
  "name": "inspect_pe_certificates",
  "arguments": { "path": "/artifacts/application.exe" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte length.
`table` is the file-offset security directory, or `null` when the directory is
absent or zero. Each `entries[]` item reports `WIN_CERTIFICATE` length,
revision, type, and the payload SHA-256.

Type-2 entries may count their zero alignment padding in `dwLength`. The PE
entry owner accepts only the exact gap to the next eight-byte boundary after
the parsed ContentInfo; extra data or nonzero counted padding fails. Entry
ranges retain all declared bytes, including counted padding. CMS payload
ranges and hashes exclude counted padding.

For `WIN_CERTIFICATE` type 2 (PKCS#7 signedData) `pkcs7` contains digest
algorithm OIDs, embedded X.509 serial/issuer/subject/validity fields, and
signer identifier facts. A signer identified by subject key identifier reports
that value as `subject_key_identifier_hex`. Other certificate types keep
`pkcs7` null.

Each name attribute reports `rdn_index`, the zero-based position of its relative
distinguished name (RDN) in the encoded name. Attributes in the same RDN share
an index. Older retained Evidence may omit the index.

A distinguished name's `text` joins those attributes in encoded order.
Attributes in one RDN are joined with `+`
(`commonName=A+organizationName=B`). Separate RDNs are joined with `, `
(`commonName=A, organizationName=B`). The separators follow
[RFC 4514](https://www.rfc-editor.org/rfc/rfc4514) multi-valued RDN notation.
Encoded order is kept, and values are copied as decoded, without RFC 4514
escaping or RDN reversal, so a name of only single-valued RDNs still places
`, ` between attributes.

Each signer reports `unsigned_attribute_oids`: null means the field was absent,
and an array lists the types when present. Older retained Evidence may omit the
field. Unsigned attribute contents, including nested signatures and timestamp
tokens, are not decoded; their presence makes coverage partial and adds a
limitation. Certificate and signer counts refer to the outer SignedData.

A missing table is observed absence of that directory. It is not proof the
image is unsigned in every catalog or overlay sense.

## Limits and failures

Confirmed DOS-only MZ files and declared NE, LE, or LX signatures are outside
this PE32/PE32+ workflow and return `unsupported_target` with target-selection
recovery. A recognized non-PE signature does not need a PE COFF header to be
classified. Unrecognized signatures and truncated PE headers remain malformed
input. `inspect-pe-resources` uses the same header admission and classifications.

The selected file is limited to 64 MiB by default (512 MiB maximum). At most
eight `WIN_CERTIFICATE` entries are examined by default. Malformed PE headers,
truncated certificate entries, and PKCS#7 that is not structurally signedData
fail without partial success. A security directory that ends before an entry's
next eight-byte boundary, or leaves fewer than eight header bytes including
zeros, is truncated and fails the same way. The
[PE format specification](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format#the-attribute-certificate-table-image-only)
requires the sum of the rounded entry lengths to equal the directory size.
SignedData must contain at least one `SignerInfo`, and each `SignerInfo` must
carry a non-empty signature value. Each embedded X.509
certificate must include `subjectPublicKeyInfo` and `signatureValue`.
Certificate issuer/subject and signer issuer names require nonempty RDN sets
and exactly two fields (type and value) in each attribute, as defined in
[RFC 5280](https://www.rfc-editor.org/rfc/rfc5280.html#section-4.1.2.4).
Malformed name structures fail before their text is reported. Decoded
certificate name text, serials, validity spellings, and subject key identifiers
share a 64 KiB budget per PKCS#7 payload, and each payload decodes at most
16,384 ASN.1 values. Exhausting either fixed allowance returns a nonretryable
`resource_constraint` error naming it, not an invalid-input error; this release
has no runtime override, and `max_file_bytes` and `max_entries` do not raise
it. Unsupported certificate name
encodings, including GeneralString, fail explicitly. TeletexString (T.61)
values are rendered with the ISO-8859-1 compatibility mapping used by OpenSSL;
this is not a full T.61 decoder, so the result includes a limitation whenever
that mapping is used. RFC 5280 retains TeletexString for backward compatibility
and describes its repertoire as ASCII-like Latin with additional characters.

The structural CMS reader accepts definite lengths and BER indefinite lengths
for constructed values, including the outer `ContentInfo` sequence. Primitive
values must have definite lengths. Embedded X.509 certificates and signed
attributes must also use definite length encoding, as required by their DER
profiles. This is a bounded structural subset: it does not implement every BER
string form or validate DER canonical encoding, and it does not verify
signatures.

This workflow does not verify signatures, certificate chains, timestamps, or
Authenticode digest coverage of image bytes.
