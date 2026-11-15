# RPM package headers

`inspect_rpm_package` / `inspect-rpm-package` reads one selected local RPM
package's lead, signature header, and main header without installing the
package, running scriptlets, verifying signatures, or decompressing the
payload. File listing comes from header tags (`BASENAMES`, `DIRNAMES`,
`DIRINDEXES`). Payload offset, size, and the declared compressor are reported
without unpacking cpio.

```bash
rea inspect-rpm-package /absolute/path/to/demo-1.0.0-1.noarch.rpm --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_rpm_package",
  "arguments": { "path": "/artifacts/demo-1.0.0-1.noarch.rpm" }
}
```

With `--detail summary --evidence_output /absolute/path/rpm.json`, the CLI
saves the complete Evidence as a new bundle and prints a summary view with
package identity, payload location, and counts of signature blobs, dependencies,
scriptlets, files, and limitations.

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte length.

`lead` reports magic `edabeedb`, version, `binary` or `source` type, architecture
and OS numbers, the lead name, and signature type. `signature` reports present
header tags: size, MD5, SHA1/SHA256 header digests, payload digest, and whether
GPG/RSA/DSA blobs are present. Blob `algorithm` and `key_id` are filled only
when those bytes are trivially decodable from an OpenPGP packet. Signature
presence does not establish trust.

`package` reports NEVRA, summary, license, vendor, packager, URL, build time,
build host, source RPM, and payload format/compressor/flags. Missing optional
tags stay `null`. Epoch `0` is reported when that tag is present.

`provides`, `requires`, `conflicts`, `obsoletes`, and weak dependency sets
(`recommends`, `suggests`, `supplements`, `enhances`) include each name,
version text, raw flags, a rendered comparison (`>=`, `=`, `<`, and siblings),
and whether the row is `rpmlib(...)` or scriptlet-only (interpreter,
pre/post install or erase, or pretrans/posttrans sense flags). When the flags
tag is absent, `flags`, `comparison`, and `scriptlet_only` are `null` rather than
`0`, unbounded, or `false`. A missing set is `null`, not an empty list.

`scriptlets` lists PREIN/POSTIN/PREUN/POSTUN/PRETRANS/POSTTRANS and triggers
with interpreter and byte length. Each trigger row lists every `TRIGGERNAME`
condition that `TRIGGERINDEX` assigns to it in `trigger_names`; other rows
report `null`. Source text is omitted unless `include_script_text` is true, and
is never executed. `files` lists header inventory rows with sizes, modes,
digests, `FILEDIGESTALGO`, config/doc flags, and owners. Without `FILEFLAGS`,
a row reports `flags`, `config`, and `doc` as `null`.

`payload.listing_source` is always `header`. The cpio payload is not
decompressed.

## Limits and failures

The selected file is limited to 64 MiB by default (512 MiB maximum). Header
index entries default to 4096 (65536 maximum), file-inventory rows default to
16384 (1048576 maximum), and one scriptlet's stored text defaults to 1 MiB
(16 MiB maximum) when requested. Exceeding a budget fails without treating the
count as zero or silently truncating.

Malformed or truncated headers fail with typed refusals. A tag the report reads
that is stored with another type or a different fixed count (for example a
`PREIN` stored as `INT32`, or a two-value `EPOCH`) is refused as malformed
rather than reported as missing. Header text is decoded as strict UTF-8 only for
values the report includes: a file path, package field, dependency, or requested
scriptlet with invalid UTF-8 is refused as malformed, and the refusal quotes the
tag, entry index, and raw bytes in hex instead of reporting text with replaced
bytes. Safely read lead and signature facts stay in `issues[].observed`. A
completed file snapshot remains available as a `file-snapshot-hash` partial
observation. Foreign magic is `unsupported_target`, not a successful parse.
