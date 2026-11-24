# Linux kernel modules

`inspect_kernel_module` / `inspect-kernel-module` reads metadata from one
selected local ELF32/ELF64 relocatable object (`.ko`) without executing it.
That metadata is the `.modinfo` key/value strings, classic `__versions` and
`CONFIG_EXTENDED_MODVERSIONS` (`__version_ext_names` and `__version_ext_crcs`)
symbol CRCs, `.gnu.linkonce.this_module` and `__ksymtab*` section presence,
decoded `__ksymtab_strings` and `__kcrctab` / `__kcrctab_gpl` entries, the
observed file sizes of `.init.text` and `.exit.text`, and an optional appended
signature trailer. It does not require a Linux host or the `modinfo` program.

```bash
rea inspect-kernel-module /absolute/path/to/module.ko --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_kernel_module",
  "arguments": { "path": "/artifacts/demo.ko" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte
length. `applicability` is `applicable` only for `ET_REL`. Other ELF types are
`not_applicable`: header facts are filled and `.modinfo`, `__versions`,
`extended_versions`, `__ksymtab*`, `__kcrctab*`, and the signature trailer are
not examined.

`.modinfo` entries stay in file order. Duplicate keys such as `alias` and
`parm` are preserved. Each entry keeps its key, value, file range, and
SHA-256. Values are the bytes after the first `=`. NUL padding between
strings is skipped. Keys and values use a byte-preserving Latin1 projection:
each source byte becomes the same-numbered Unicode code point. They are not
decoded as UTF-8. `raw_sha256` hashes the original entry bytes, including its
terminating NUL when present; `raw_hex` shows those bytes when they fit the
inline limit.

`__versions` entries are `struct modversion_info`: a 64-byte record whose CRC
is an `unsigned long` and whose name occupies the remaining bytes. ELF32
stores a 32-bit CRC and a 60-byte name. ELF64 stores a 64-bit unsigned long
and a 56-byte name. CRCs are zero-padded lowercase hex, 8 or 16 characters,
not a JavaScript number. The layout is reported from the ELF class even when
the section is absent. Names use the same byte-preserving Latin1 projection
as `.modinfo` keys and values. `versions.status: "absent"` means no `__versions`
section was found when section names were complete.

`extended_versions` decodes `CONFIG_EXTENDED_MODVERSIONS` metadata from
`__version_ext_names` and `__version_ext_crcs`. `__version_ext_names` holds
NUL-separated symbol names (with trailing NUL alignment padding accepted after
the paired entries) paired 1:1 in order with `u32` CRCs in ELF byte order from
`__version_ext_crcs` (`entry_crc_bytes: 4`, 8-character lowercase hex). Both
sections' file ranges, SHA-256 digests, and counts are reported in
`names_section` and `crcs_section`.

`.gnu.linkonce.this_module` is reported as present, absent, unknown, or
unsupported. `unsupported` means the section is stored `SHF_COMPRESSED`; its
file range is reported and the payload is not inflated.
`layout` is always `unknown` because `struct module` changes with the kernel
version and is not decoded. File-backed `__ksymtab*` sections are listed in
section-header order by name and file range. Sections that are `SHT_NOBITS` or
leave the file are counted in one limitation without their names.
`ksymtab.strings` decodes NUL-terminated exported symbol and namespace strings
from `__ksymtab_strings` in section order (skipping NUL padding), while
`ksymtab.kcrctab` and `ksymtab.kcrctab_gpl` decode 4-byte `u32` CRC arrays in
ELF byte order from `__kcrctab` and `__kcrctab_gpl`. Because
`struct kernel_symbol` entries in `__ksymtab*` use kernel-version-specific
PREL32 or pointer-sized ELF relocations that this workflow does not resolve,
`ksymtab.strings` entries and `ksymtab.kcrctab` / `ksymtab.kcrctab_gpl` CRCs
are not paired to each other or to symbol/namespace roles, and legacy
`unsigned long` or pre-relocation placeholder values are not distinguished.
`.init.text` and `.exit.text` report the
observed file-backed size. A compressed payload reports the stored size and a
limitation that the decoded size is unknown.

The signature trailer is the 28-byte magic `~Module signature appended~\n`
preceded by a 12-byte `module_signature` (`algo`, `hash`, `id_type`,
`signer_len`, `key_id_len`, three pad bytes, and big-endian `sig_len`). When
those parameter fields are zero, `id_type` is PKCS#7 (`2`), and `sig_len` is
positive, the report gives the preceding PKCS#7 range and its SHA-256.
Certificate, signer, and digest coverage remain unobserved. An absent trailer
records observed absence for this input.

When section names are incomplete, a missing named section is `unknown`
rather than `absent`. An empty file-backed section is present and empty.

`coverage.status` is `partial` when supported facts cannot all be examined or
interpreted, including incomplete section names, malformed or unsupported
metadata, omitted string text, and omitted duplicate named sections. When
multiple `.modinfo`, `__versions`, `__version_ext_names`, `__version_ext_crcs`,
`.gnu.linkonce.this_module`, `__ksymtab_strings`, `__kcrctab`, `__kcrctab_gpl`,
`.init.text`, or `.exit.text` sections exist, the first is examined and a
limitation identifies the omission. `complete` covers the supported inspection
described here; it does not claim that `struct module`, `struct kernel_symbol`
relocations, or certificate chains were decoded.

## Limits and failures

The selected file is limited to 64 MiB by default (512 MiB maximum). At most
8192 decoded `.modinfo`, `__versions`, `extended_versions`, `__ksymtab_strings`,
and `__kcrctab` / `__kcrctab_gpl` entries plus listed `__ksymtab*` sections are
scanned by default (65536 maximum, including mismatched `extended_versions`
records whose paired rows are withheld); `coverage.examined_entries` counts
returned rows and sections. Exceeding that budget fails with no partial success.
`.modinfo` keys
retain at most 256 bytes and values at most 4096 bytes by default. A larger
field becomes `null` and is named in the entry's `omitted_fields`; the field
that fits is still copied. Structural `status` and `reason` remain independent:
a terminated, nonempty `key=value` entry stays `observed` when its text is
omitted, while overall coverage becomes `partial`. Source range and digest
remain available.

Raise `max_modinfo_key_bytes` or `max_modinfo_value_bytes` on the next MCP call
to retain the omitted text. The returned limitation names the required byte
budget, and `modinfo.omission_limits` records each control that omitted text
(`control_kind: "parameter"`, with its effective value, default and range).
CLI flags are `--max-modinfo-key-bytes` and `--max-modinfo-value-bytes`.
Each accepts an integer from 1 through 536870912 bytes, matching the maximum
input size. No restart is required; file, entry and raw-hex budgets do not
change. These are per-call controls, not runtime settings.

A `__ksymtab*` section name longer than
256 bytes keeps its range with `name: null` and `ksymtab_name_exceeds_limit`.
Inline raw hex and inline `__ksymtab_strings` / `__version_ext_names` text stop
at 4096 bytes while keeping the source range and SHA-256 (`omitted: true`,
`coverage.status: "partial"` without marking valid syntax malformed).

A `.modinfo` span with no trailing NUL is `unterminated_modinfo_entry` and
earlier entries are kept. A string with no `=` is `modinfo_missing_separator`.
An empty key is `modinfo_empty_key`. A `__versions` name with no NUL is
`version_name_unterminated`. A `__versions` section whose size is not a
multiple of 64 bytes is closed with `versions_size_not_multiple` and no
entries. `SHT_NOBITS` or a declared range that leaves the file is
`modinfo_section_not_file_backed`, `versions_section_not_file_backed`,
`ksymtab_strings_section_not_file_backed`, `kcrctab_section_not_file_backed`,
`version_ext_names_not_file_backed`, or `version_ext_crcs_not_file_backed`.
`SHF_COMPRESSED` payloads are not inflated
(`modinfo_section_compressed`, `versions_section_compressed`,
`ksymtab_strings_section_compressed`, `kcrctab_section_compressed`,
`version_ext_names_compressed`, `version_ext_crcs_compressed`). An unterminated
entry in `__ksymtab_strings` is `ksymtab_string_unterminated`. A `__kcrctab` or
`__kcrctab_gpl` section whose size is not a multiple of 4 bytes is closed with
`kcrctab_size_not_multiple`. For `CONFIG_EXTENDED_MODVERSIONS`, a missing pair
section is `version_ext_names_missing` or `version_ext_crcs_missing`, a CRC
section not divisible by 4 is `version_ext_crcs_size_not_multiple`, a count
mismatch between CRCs and names closes paired output with
`version_ext_count_mismatch`, an unterminated symbol name is
`version_ext_name_unterminated`, and an empty symbol name is
`version_ext_empty_name`.

`signature_trailer_truncated` is reserved for an appended magic with fewer
than 12 preceding bytes. ELF admission requires at least 52 (ELF32) or 64
(ELF64) bytes, so this inspection never returns it for an admitted file. A
`sig_len` that leaves no module bytes or names an empty PKCS#7 range is
`signature_length_inconsistent`. Nonzero `algo`, `hash`, signer, key-id, or
pad fields for PKCS#7 are `signature_parameters_nonzero`.
A parameter block whose `id_type` is not PKCS#7 is
`signature_id_type_not_pkcs7` and is unsupported rather than a validated
signature.

gzip (`1f 8b`), xz (`fd 37 7a 58 5a 00`), and zstd (`28 b5 2f fd`) whole-file
containers are `unsupported`. The result names `external_decompression` as the
next probe and does not claim the payload is a kernel module. This is an external
step, not a REA operation: neither this tool nor `extract_artifact` decodes these
containers. Use an external gzip, xz, or zstd utility to decompress into a separate
file, then call `inspect_kernel_module` on that file to inspect the `ET_REL` image.

Malformed ELF headers return no partial kernel-module metadata. This workflow
does not execute the module or validate an appended signature.

## Format references

The record layout follows Linux v6.12's
[`modversion_info`](https://github.com/torvalds/linux/blob/v6.12/include/linux/module.h)
and [`MAX_PARAM_PREFIX_LEN`](https://github.com/torvalds/linux/blob/v6.12/include/linux/moduleparam.h).
The [Linux kbuild module versioning guide](https://docs.kernel.org/kbuild/modules.html#module-versioning)
describes the separate extended version sections.
Trailer fields and acceptance rules follow
[`module_signature`](https://github.com/torvalds/linux/blob/v6.12/include/linux/module_signature.h)
and [`mod_check_sig`](https://github.com/torvalds/linux/blob/v6.12/kernel/module_signature.c).
These references establish the decoded layout, not runtime verification.

## Real-module verification lane

Run from a built checkout with Docker available. This downloads a Debian kernel
package into a disposable container, extracts a filesystem module, decompresses
it when necessary, and inspects it with REA. It never installs or loads that
kernel module. The temporary output is outside the repository; record the
printed package version and module digest with results.

```bash
module_lane=$(mktemp -d)
docker run --rm -i -v "$module_lane:/out" debian:stable bash -se <<'CONTAINER'
apt-get update -qq
apt-get install -y --no-install-recommends xz-utils zstd ca-certificates
cd /tmp
arch=$(dpkg --print-architecture)
package=$(apt-cache depends "linux-image-$arch" | awk '/Depends: linux-image-[0-9]/{print $2; exit}')
test -n "$package"
apt-get download "$package"
dpkg-deb -f ./*.deb Package Version > /out/package.txt
dpkg-deb -x ./*.deb /tmp/kernel
module=$(find /tmp/kernel -type f -path '*/kernel/fs/*' \( -name '*.ko' -o -name '*.ko.xz' -o -name '*.ko.zst' -o -name '*.ko.gz' \) | sort | head -1)
test -n "$module"
case "$module" in
  *.xz) xz -dc "$module" > /out/module.ko ;;
  *.zst) zstd -dc "$module" > /out/module.ko ;;
  *.gz) gzip -dc "$module" > /out/module.ko ;;
  *) cp "$module" /out/module.ko ;;
esac
cat /out/package.txt
sha256sum /out/module.ko
CONTAINER
node scripts/rea.mjs inspect-kernel-module "$module_lane/module.ko" --json > "$module_lane/rea.json"
python3 - "$module_lane" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
report = json.loads((root / 'rea.json').read_text())['normalized_result']
entries = report['modinfo']['entries']
assert entries and all(entry['status'] == 'observed' for entry in entries)
keys = [entry['key'] for entry in entries]
for key in ('license', 'vermagic', 'name'):
    assert key in keys, key
print('Observed .modinfo entries:', len(entries), 'distinct keys:', len(set(keys)))
print('Artifact:', report['artifact'])
PY
```

`parm` and `parmtype` are retained separately by REA. Synthetic tests cover
their generic key/value representation and all four ELF class/byte-order
combinations. A successful real lane verifies only the selected module and
printed fields; it does not validate certificates. This lane has not run in the
sandbox used for implementation because access to the Docker socket was denied.
