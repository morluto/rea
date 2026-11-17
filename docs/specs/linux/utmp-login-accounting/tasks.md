# Tasks: Linux login-accounting Evidence

## Slice 1 — layout selection and record decoding

- [x] Publish the supported profiles from glibc headers, with the header and
      macro each one comes from.
- [x] Share the record head between layouts and derive the tail offsets from the
      profile's session and time widths.
- [x] Select a profile explicitly, and report `ambiguous_format` instead of
      guessing when the length matches more than one.
- [x] Decode fixed-width strings through `strictUtf8` and name any field without a
      terminator or valid UTF-8.
- [x] Keep unknown `ut_type` values inspectable with the raw number.
- [x] Report a truncated tail without discarding the records before it.
- [x] Return an empty result for an empty file, which carries no layout facts.
- [x] Cover both layouts and every diagnostic in `utmp.test.ts`.

## Slice 2 — timeline and correlation

- [ ] Normalize records into a timeline that retains the source file and offset.
- [ ] Correlate `wtmp` logouts with the `utmp` sessions that opened them.
- [ ] Keep `btmp` failed logins distinguishable from successful ones.
- [ ] Prove correlation does not merge records that share only user, terminal or
      timestamp.

## Slice 3 — CLI and MCP surface

- [ ] Command taking the supplied files plus a stated profile.
- [ ] Bounded paging over records with the diagnostics rendered.
- [ ] Boundary regression through the public command.

## Outstanding verification

- [ ] Capture a real `wtmp` from an x86-64 and an aarch64 host and confirm the
      selected profile decodes it; the layouts are header-derived today.
- [ ] Decide whether Android's bionic layout needs its own profile.
