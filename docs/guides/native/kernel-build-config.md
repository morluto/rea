# Linux kernel build config

`inspect_kernel_build_config` / `inspect-kernel-build-config` reads the
`Linux version` banner and the embedded `.config` from one selected local
kernel image without executing or booting it. Accepted inputs are a `vmlinux`
ELF, a raw arm64 `Image`, an x86 `bzImage` or `zImage` whose payload is gzip,
and a `configs.ko` module. It does not require a Linux host,
`extract-ikconfig`, or `/proc/config.gz`.

```bash
rea inspect-kernel-build-config /absolute/path/to/vmlinux --json
rea inspect-kernel-build-config /absolute/path/to/bzImage --name CONFIG_SECURITY_SELINUX --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_kernel_build_config",
  "arguments": { "path": "/artifacts/vmlinux", "name": "CONFIG_MODULE_SIG" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte
length. `format` is `elf` when the file starts with the ELF magic and `file`
otherwise.

`banner` is the first printable string that starts with `Linux version `
followed by a version token beginning with a digit and ends at a NUL or
newline within 512 bytes. `version` is that token. `builder` is the first
parenthesized group (`user@host`). `compiler` is the second group up to the
last `) #`, so nested parentheses in compiler strings are kept. The banner is
`absent` when no such string was found in the searched bytes and `unknown`
when the bytes were not searched.

`config` is `present` only when all of the following hold:

- `IKCFG_ST` is immediately followed by a gzip member (`1f 8b 08`).
- The member inflates within `max_config_bytes` and its CRC-32 and ISIZE
  trailer match.
- The member trailer ends exactly at the first `IKCFG_ED` after the gzip
  header. Inflation reads only the bytes up to that marker.
- Every non-blank line of the inflated text is a `#` comment,
  `# CONFIG_X is not set`, or `CONFIG_X=value`, and the text is valid UTF-8
  with no control bytes other than tab, CR, and LF.

An `IKCFG_ST` string that is not followed by gzip magic, or whose complete
member is not followed by `IKCFG_ED`, is skipped, so an ordinary string is never
reported as a config. When `IKCFG_ST`, gzip magic, and a later `IKCFG_ED` frame
a member that does not decode, a deflate stream cut off by that marker, a
member that fails its CRC-32 or ISIZE check, or text that fails the grammar,
the config is `malformed` with coverage
`incomplete`, and `marker`, `gzip`, and `end_marker` locate the blob. A
malformed blob is never reported as an absent config. A valid config later in
the searched bytes still wins. `marker`, `gzip`, and `end_marker` give
the three ranges. `sha256` hashes the inflated text. `option_count` counts
every `CONFIG_*` line. `matched_count` counts the options that match the
optional exact `name` filter, and `entries` is the `offset`/`limit` page of
those matches in file order.

Each entry has a `name`, a `kind`, and a `value`:

| `kind`    | Source line                | `value`                   |
| --------- | -------------------------- | ------------------------- |
| `y`, `m`  | `CONFIG_X=y`, `CONFIG_X=m` | `y` or `m`                |
| `number`  | decimal or `0x` hex        | the text as written       |
| `string`  | `CONFIG_X="..."`           | decoded text (`\"`, `\\`) |
| `not_set` | `# CONFIG_X is not set`    | `null`                    |

Banner text and configuration values are target-derived and untrusted.

## bzImage payloads

A file with `HdrS` at offset `0x202` is an x86 setup header. From boot
protocol 2.08, `payload_offset` and `payload_length` locate the compressed
kernel after the `(setup_sects + 1) * 512` setup code. `payload` reports the
container, codec, file range, and inflated length. A gzip payload is inflated
within `max_payload_bytes` and the inflated bytes are searched. Locations in
those bytes have `space: "inflated_payload"` and are offsets in the inflated
payload, not file offsets. Only the leading gzip member is inflated, and its
own ISIZE trailer gives the inflated length. Kbuild appends a separate 4-byte
size only for the non-gzip codecs. Any bytes after the gzip member inside the
payload are not read.

xz, lz4, lzma, zstd, bzip2, and lzo payloads are `unsupported`. The result
names the codec and `external_decompression` as the next probe. This is an
external step, not a REA operation: decompress the payload with the matching
utility into a separate file, then call `inspect_kernel_build_config` on that
file. A file that is itself a compressed stream, including a whole-file gzip
such as `Image.gz`, is reported as `unsupported` with its codec and is not
inflated. Only a gzip payload inside a bzImage is inflated.

## Limits and failures

The selected file is limited to 64 MiB by default (512 MiB maximum). An IKCFG
member may inflate to 4 MiB by default (32 MiB maximum) and a bzImage payload
to 128 MiB by default (512 MiB maximum). At most 16384 `CONFIG_*` options are
examined by default (65536 maximum). A page holds 256 entries by default
(4096 maximum). Exceeding any budget fails with no partial success and names
the option to raise. An IKCFG member past `max_config_bytes` fails that way only
when no later candidate is accepted, so an oversized decoy cannot hide a valid
config.

One search inflates at most 16 `IKCFG_ST` gzip candidates and at most four
times `max_config_bytes` of output across them. A candidate whose stream fails
partway through is charged its full per-candidate allowance, since its partial
output is not measured. When that search budget runs
out before a config is accepted, the config is `incomplete` with reason
`config_search_exhausted` instead of failing or reporting an absent config.
Inflation runs off the event loop. Every scan, including marker
searches that find nothing, config text checks, validation of one long value,
and hashing, yields to it at least once
per MiB, so a cancellation that arrives while the image is being parsed is honored
at the next check. One inflate call runs to its output bound once started.

Results that could not search or read the kernel bytes stay `incomplete`,
`malformed`, or `unsupported` and are never
reported as an absent config:

| `config.reason`                    | Meaning                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| `config_gzip_invalid`              | a framed `IKCFG_ST` gzip member does not decode or fails its CRC-32 or ISIZE |
| `config_text_invalid`              | a framed `IKCFG_ST` gzip member is not `.config` text                        |
| `config_gzip_truncated`            | an `IKCFG_ST` gzip member runs past the searched bytes                       |
| `config_search_exhausted`          | decoy candidates used up the config search budget                            |
| `payload_truncated`                | the declared bzImage payload or its gzip member ends early                   |
| `payload_gzip_invalid`             | the bzImage gzip payload fails to inflate or its trailer                     |
| `payload_codec_unsupported`        | a compressed payload or whole-file stream was not inflated                   |
| `unrecognized_payload_codec`       | the bzImage payload starts with no known codec magic                         |
| `setup_header_payload_unavailable` | the setup header predates 2.08 or has no payload length                      |

A kernel built without `CONFIG_IKCONFIG` carries no embedded config, so an
`absent` config describes only the bytes that were searched. A kernel built
with `CONFIG_IKCONFIG=m` keeps the config in `configs.ko`; inspect that module
instead of the image. This workflow does not execute the image, compare the
config with a source tree, or evaluate Kconfig dependencies.

## Format references

The markers follow Linux v6.12's
[`kernel/configs.c`](https://github.com/torvalds/linux/blob/v6.12/kernel/configs.c)
and
[`scripts/extract-ikconfig`](https://github.com/torvalds/linux/blob/v6.12/scripts/extract-ikconfig).
The setup header fields follow the
[x86 boot protocol](https://docs.kernel.org/arch/x86/boot.html). The banner
format follows
[`init/version-timestamp.c`](https://github.com/torvalds/linux/blob/v6.12/init/version-timestamp.c).
These references establish the decoded layout, not runtime behavior.
