# Plan: Linux login-accounting Evidence

Slices land separately so each one is reviewable on its own.

## Slice 1 — layout selection and record decoding (this change)

`src/domain/linux/utmp.ts` publishes the supported glibc and musl profiles,
selects one explicitly, and decodes records with the diagnostics in `spec.md`. It reads
through `BinaryReader`, so bounds and truncation failures use the shared parser
algebra, and it decodes fixed-width strings through `strictUtf8`.

Open questions this slice does not answer:

- Which layout a real Ubuntu 22.04/24.04 image writes. The profiles come from
  glibc's and musl's headers, not from a captured host file; a real `wtmp` from
  each target ABI would settle it and is the first thing to verify before
  advertising the capability to analysts.
- Whether Android writes the same layouts. bionic's `struct utmp` is separate;
  no Android profile is claimed.
- The 32-bit musl layout, where `timeval` is 8 bytes. It is not published yet
  because no captured file has confirmed its size.

## Slice 2 — timeline and correlation

Normalize records into one timeline that keeps each record's source file and
offset, so a `wtmp` logout can be tied to the `utmp` session that opened it
without collapsing two records that merely share a user, terminal or timestamp.
`botmp` failed-login records stay distinguishable from successful ones.

## Slice 3 — CLI and MCP surface

A command that takes the supplied files plus the stated profile, returns records
with bounded paging, and renders the diagnostics above. The command must let the
caller state the profile, because an ambiguous file cannot be decoded without it.

## Verification

- Slice 1: `src/domain/linux/utmp.test.ts` covers both layouts, profile selection,
  ambiguity, truncated tails, unknown types, unterminated fields and empty files.
- Slice 2: producer goldens for correlation, plus a boundary regression through
  the public command once slice 3 lands.
- Real-host verification is outstanding for every slice; simulated fixtures do
  not establish what a real `wtmp` contains.
