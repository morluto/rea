# Linux login-accounting Evidence

Parse acquired `utmp`, `wtmp` and `btmp` files into records with preserved
provenance. Read-only and offline: this never queries host login services and
never writes, rotates or truncates the supplied files.

Tracking issue: [#11351](https://github.com/morluto/rea/issues/11351).

## Why the layout has to be stated

glibc's `struct utmp` is not one structure. `ut_session` and `ut_tv` are 32-bit
where the ABI keeps 64-bit and 32-bit processes on the same accounting files, and
`long`-typed where it does not — `bits/utmp.h` selects between them with
`__WORDSIZE_TIME64_COMPAT32`.

Read from glibc's own headers:

| Header                            | Macro                          | Record    |
| --------------------------------- | ------------------------------ | --------- |
| `sysdeps/x86/bits/wordsize.h`     | `__WORDSIZE_TIME64_COMPAT32 1` | 384 bytes |
| `sysdeps/aarch64/bits/wordsize.h` | `__WORDSIZE_TIME64_COMPAT32 0` | 400 bytes |

Both layouts share the record head and diverge in the tail, so decoding the tail
under the wrong layout silently produces plausible timestamps and session ids.
Record length narrows the layout, but never names the byte order, and the least
common multiple (9600) narrows nothing at all. Selection is therefore explicit:
an ambiguous file is reported and refused rather than decoded under a guess.

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

Diverging tail:

| Field                  | `__WORDSIZE_TIME64_COMPAT32` | otherwise             |
| ---------------------- | ---------------------------- | --------------------- |
| `ut_session`           | 336, 4 (signed)              | 336, 8 (signed)       |
| `ut_tv.tv_sec`         | 340, 4 (unsigned)            | 344, 8 (unsigned)     |
| `ut_tv.tv_usec`        | 344, 4 (signed)              | 352, 8 (signed)       |
| `ut_addr_v6[4]`        | 348, 16                      | 360, 16               |
| `__glibc_reserved[20]` | 364                          | 376                   |
| record size            | 384                          | 400 (396 padded to 8) |

## Records and diagnostics

A record keeps its file offset, the raw `ut_type` alongside the glibc name when
one exists, the decoded fixed-width strings, exit status, session id, timestamp
and the four `ut_addr_v6` words. A fixed-width field that carries no terminator,
or whose bytes are not well-formed UTF-8, still decodes as far as it can and is
named in `undecodedFields`.

Reported issues:

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
