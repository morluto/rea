# Linux kernel build config

## Problem and outcome

Analysing a Linux kernel image usually starts with two questions: which kernel
version is this, and how was it configured. A kernel built with
`CONFIG_IKCONFIG` embeds its `.config` as a gzip blob between `IKCFG_ST` and
`IKCFG_ED`. REA reports kernel modules and ELF notes, but it cannot read the
version banner or the embedded config, so an agent needs a Linux host and
`scripts/extract-ikconfig`.

This feature adds `inspect_kernel_build_config` and
`inspect-kernel-build-config`. They read one selected local kernel image and
report its `Linux version` banner and embedded build config, without
executing or booting it.

[Linux kernel build config](../../../guides/native/kernel-build-config.md) describes the
current behavior and limitations. This directory is the feature
specification, implementation plan and task list. The guide does not replace
these files.

## Requirements

1. Accepted inputs are a `vmlinux` ELF, a raw arm64 `Image`, an x86 `bzImage`
   or `zImage` whose payload is gzip, and a `configs.ko` module. The file is
   read through the stable artifact read and never executed.
2. The banner is the first printable `Linux version ` string followed by a
   version token that starts with a digit and ends at a NUL or newline within
   512 bytes. Version, builder and compiler are split from it. The scan is
   linear in the searched bytes.
3. A config is `present` only when `IKCFG_ST` is followed by a gzip member that
   ends exactly at the next `IKCFG_ED`, inflates within `max_config_bytes`,
   passes its CRC-32 and ISIZE checks, and parses as `.config` text. Inflation
   reads only the bytes up to that marker.
4. Framing that fails its checks or grammar, including a framed deflate stream
   that does not decode or is cut off by `IKCFG_ED`, is `malformed`, never
   `absent`. An unframed `IKCFG_ST` string is skipped. A valid config later in the bytes
   still wins.
5. Entries report name, kind (`y`, `m`, `number`, `string`, `not_set`) and
   value, with an exact `name` filter and `offset`/`limit` paging.
6. A bzImage setup header from boot protocol 2.08 locates the payload. A gzip
   payload is inflated within `max_payload_bytes` and searched, with locations
   marked `inflated_payload`. Other payload codecs, and a file that is itself a
   compressed stream such as `Image.gz`, are `unsupported` and name the codec,
   using the codec detection shared with the kernel module parser.
7. Budgets bound file size, config and payload inflate size, option count and
   page size. The config search inflates at most 16 candidates and at most
   four times `max_config_bytes` in total, charging a stream that fails
   partway through its full per-candidate allowance. Exhausting the search budget is
   `incomplete` with `config_search_exhausted`. A member past
   `max_config_bytes` fails the budget only when no later candidate is
   accepted.
8. Cancellation is checked between candidates, between banner hits, while
   scanning long text and while parsing config lines. Inflation runs off the
   event loop and each scan yields to it at least once per MiB, so a live
   cancellation reaches those checks.
9. Banner text and config values are marked target-derived and untrusted.
10. MCP requires an absolute path. The CLI resolves relative paths against the
    working directory.

## Acceptance

- Unit tests cover banner parsing, config framing, grammar, malformed and
  truncated members, decoy candidates, search budgets, cancellation, and
  bzImage payload handling.
- Service tests cover each status and reason.
- CLI acceptance, filesystem boundary and MCP boundary tests exercise the
  public contract.

## Non-goals

- Decompressing xz, lz4, lzma, zstd, bzip2 or lzo payloads.
- Comparing the config with a source tree or evaluating Kconfig dependencies.
- Executing or booting the image.
