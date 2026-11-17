# Linux login-accounting Evidence

Parse acquired `utmp`, `wtmp` and `btmp` files into records with preserved
provenance. Read-only and offline: this never queries host login services and
never writes, rotates or truncates the supplied files.

Tracking issue: [#11351](https://github.com/morluto/rea/issues/11351).

## Why the layout has to be stated

The record has no single layout across libc and ABI.

glibc selects the tail shape with `__WORDSIZE_TIME64_COMPAT32` in `bits/utmp.h`:
`ut_session` is `int32_t` with a 32-bit `ut_tv`, or `long` with a 64-bit one. Read
from glibc's own headers, `sysdeps/x86/bits/wordsize.h` defines that macro as `1`
and `sysdeps/aarch64/bits/wordsize.h` as `0`.

musl (`include/utmpx.h`) is a third shape: `ut_session` is always `int`, followed
(or, on a big-endian host, preceded) by `__ut_pad2`, and `ut_addr_v6` is
`unsigned` rather than glibc's `int32_t`.

The consequences that make guessing unsafe:

- The same 400-byte length is glibc with 64-bit time (session 8 bytes) or musl
  with 32-bit time plus padding (session 4 bytes) — different offsets for the
  timestamp.
- Reading musl bytes as the glibc layout folds the padding into the session id's
  high half.
- Record length narrows the layout but never names the byte order, and a length
  that is a multiple of every layout (9600) narrows nothing.

Selection is therefore explicit, and an ambiguous file is refused rather than
decoded under a guess.

## Layouts

Shared head, from `bits/utmp.h` with `UT_LINESIZE` 32, `UT_NAMESIZE` 32 and
`UT_HOSTSIZE` 256:

| Field                   | Offset | Size       |
| ----------------------- | ------ | ---------- |
| `ut_type`               | 0      | 2 (signed) |
| `ut_pid`                | 4      | 4 (signed) |
| `ut_line`               | 8      | 32         |
| `ut_id`                 | 40     | 4          |
| `ut_user`               | 44     | 32         |
| `ut_host`               | 76     | 256        |
| `ut_exit.e_termination` | 332    | 2 (signed) |
| `ut_exit.e_exit`        | 334    | 2 (signed) |

Published profiles:

| Profile           | Record | `ut_session`        | `ut_tv`         | `ut_addr_v6`  |
| ----------------- | ------ | ------------------- | --------------- | ------------- |
| `glibc-time32`    | 384    | 336, 4              | 340, 4 + 344, 4 | 348, signed   |
| `glibc-time64`    | 400    | 336, 8              | 344, 8 + 352, 8 | 360, signed   |
| `glibc-time64-be` | 400    | 336, 8              | 344, 8 + 352, 8 | 360, signed   |
| `musl-time64`     | 400    | 336, 4 (pad at 340) | 344, 8 + 352, 8 | 360, unsigned |
| `musl-time64-be`  | 400    | 340, 4 (pad at 336) | 344, 8 + 352, 8 | 360, unsigned |

`glibc-time32` covers glibc where the macro is set — x86, both word sizes — and
any ABI that keeps 32-bit session and time fields.

## Records and diagnostics

A record keeps its file offset, the raw `ut_type` alongside the glibc name when
one exists, the decoded fixed-width strings, exit status, session id, timestamp
and the four `ut_addr_v6` words. A fixed-width field that carries no terminator,
or whose bytes are not well-formed UTF-8, still decodes as far as it can and is
named in `undecodedFields`.

| Issue                      | Cause                                                               |
| -------------------------- | ------------------------------------------------------------------- |
| `ambiguous_format`         | The length matches more than one profile and none was stated.       |
| `truncated_trailing_bytes` | The file ends mid-record; earlier records stay readable.            |
| `unknown_type`             | `ut_type` has no glibc name; the numeric value is kept.             |
| `undecoded_field`          | A fixed-width field had no terminator or was not well-formed UTF-8. |

## Out of scope

This does not authenticate users, establish who physically operated a machine, or
assert that records were not altered. Cross-file correlation and the CLI surface
are separate slices; see `plan.md`.
