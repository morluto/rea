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

`utmp(5)` documents the same split with its own spelling
(`__WORDSIZE == 64 && defined __WORDSIZE_COMPAT32`), so the shape comes from two
independent sources rather than one header.

musl (`include/utmpx.h`) is a third shape: `ut_session` is always `int`, followed
(or, on a big-endian host, preceded) by `__ut_pad2`, and `ut_addr_v6` is
`unsigned` rather than glibc's `int32_t`.

The consequences that make guessing unsafe:

- The same 400-byte length is glibc (session 8 bytes wide) or musl (session 4
  bytes wide plus 4 bytes of padding). Both put 64-bit seconds at 344 and
  microseconds at 352, so the timestamps agree; the session field does not.
- Reading musl bytes as the glibc layout folds that padding into the session id's
  high half, so one file yields two different session ids depending on the
  profile stated.
- On a big-endian host musl puts the padding before the session id, which moves
  the session four bytes later than on a little-endian host.
- Record length names no layout at all. A truncated tail lets a larger record
  explain any shorter length, so an exact-divisibility filter would advertise the
  smaller layout for bytes a larger one wrote — 384 bytes is one x86 record and
  also an aarch64 record missing its last 16 bytes.

Record sizes are arithmetic on those fields: the head, the tail and
`__glibc_reserved[20]`, padded to the 8-byte alignment `struct timeval` forces.
`utmp.test.ts` re-derives each published size from its own offsets, so a profile
cannot advertise a length its fields do not fill.

Selection is therefore explicit. `parseUtmpFile` requires a profile: because a
truncated tail lets a larger record explain any shorter length, the length never
proves the ABI on its own, so an omitted profile is reported as `ambiguous_format`
listing every profile instead of being resolved from the length.

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
| `glibc-time32-be` | 384    | 336, 4              | 340, 4 + 344, 4 | 348, signed   |
| `glibc-time64`    | 400    | 336, 8              | 344, 8 + 352, 8 | 360, signed   |
| `glibc-time64-be` | 400    | 336, 8              | 344, 8 + 352, 8 | 360, signed   |
| `musl-time64`     | 400    | 336, 4 (pad at 340) | 344, 8 + 352, 8 | 360, unsigned |
| `musl-time64-be`  | 400    | 340, 4 (pad at 336) | 344, 8 + 352, 8 | 360, unsigned |

`glibc-time32` covers glibc where the macro is set — x86, both word sizes — and
any ABI that keeps 32-bit session and time fields. The macro is not an x86-only
fact: `s390x` and big-endian `ppc64` define it as well, so the 384-byte shape also
appears byte-swapped. `glibc-time32-be` is the same record with `byteOrder: "big"`;
without it those files have no correct profile and every numeric field — the type,
PID, session, both time words and each address word — would read byte-swapped.

## Records and diagnostics

A record keeps its file offset, the raw `ut_type` alongside the glibc name when
one exists, the decoded fixed-width strings, exit status, session id, timestamp,
the `ut_addr_v6` words its bytes held, and a `coverage` member naming the members
they did not reach. A tail that ends inside the fourth address word still yields
the login, so `coverage` distinguishes "this word was absent" from "this word is
zero" instead of returning a shorter array a consumer would read as data.

Signed fields are sign-extended at their declared width: `ut_type` and the exit
status at 16 bits, `ut_session` at its profile width, and `tv_sec` as a signed
`time_t`, so a pre-epoch or clock-change timestamp stays negative.

A 64-bit field can carry a value `Number` cannot represent — a supplied file makes
that reachable, and rounding it would collapse two distinct records onto one
value. The record keeps the rounded number every consumer reads and the exact
decimal in `imprecise_field`, so the source fact is never lost silently.

A supplied profile is resolved by name to the published layout, so a mutated copy
cannot supply a `recordBytes` the parser then divides by; a name that is not
published is `unknown_format` rather than a decode.

`maxRecords` is admitted only as a nonnegative safe integer. `NaN`, a fraction, a
negative value and `Infinity` are all `number` but none is a record count:
accepting them would make the retained records, `omitted`, and the
`UTMP_RECORD_LIMIT` ceiling disagree with each other.

The fixed-width string members are `__attribute_nonstring__`, so a field that
fills its whole width is well formed without a terminator. Only malformed UTF-8
marks a field: the readable prefix is kept, the remaining records still decode, and
`undecodedFields` carries that member's bytes up to its terminator as hex. The
prefix alone would collapse `alice` + `0xff` + `-admin` and a genuine `alice` into
the same user, which a forensic record cannot do.

| Issue                      | Cause                                                                         |
| -------------------------- | ----------------------------------------------------------------------------- |
| `ambiguous_format`         | The length matches more than one profile and none was stated.                 |
| `truncated_trailing_bytes` | The file ends mid-record; a tail holding every modeled field still decodes.   |
| `unknown_type`             | `ut_type` has no glibc name; the numeric value is kept.                       |
| `undecoded_field`          | A fixed-width field was not well-formed UTF-8; the prefix is kept.            |
| `imprecise_field`          | A 64-bit field is outside `Number`'s exact range; the stored decimal is kept. |
| `invalid_record_budget`    | `maxRecords` is not a nonnegative safe integer; the value is rejected.        |
| `unknown_format`           | The supplied profile name is not published; the name is kept.                 |

## Bounds

Retention is bounded. `maxRecords` (default `UTMP_RECORD_LIMIT`, 10 000) caps how
many records one call materializes, so a large or hostile log cannot amplify the
bytes already loaded into an unbounded object graph. Exceeding it reports
`record_budget_exceeded` with the number omitted rather than silently truncating.

## Out of scope

This does not authenticate users, establish who physically operated a machine, or
assert that records were not altered. Cross-file correlation and the CLI surface
are separate slices; see `plan.md`.
