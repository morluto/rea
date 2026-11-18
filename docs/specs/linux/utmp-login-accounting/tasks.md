# Tasks: Linux login-accounting Evidence

## Slice 1 — layout selection and record decoding

- [x] Publish the supported glibc and musl profiles, with the header each one
      comes from.
- [x] Share the record head between layouts and derive the tail offsets from the
      profile's session width, padding side and time width.
- [x] Keep musl's session padding and unsigned address separate from glibc's
      wider session id, so the two 400-byte families are distinguishable.
- [x] Select a profile explicitly, and report `ambiguous_format` instead of
      guessing when the length matches more than one.
- [x] Decode fixed-width strings through `strictUtf8` and name any field that is not
      valid UTF-8. A member that fills its whole width is well formed without a
      terminator (`__attribute_nonstring__`), so only malformed bytes are marked.
- [x] Keep unknown `ut_type` values inspectable with the raw number.
- [x] Report a truncated tail without discarding the records before it.
- [x] Return an empty result for an empty file, which carries no layout facts.
- [x] Cover both layouts and every diagnostic in `utmp.test.ts`.

## Slice 2 — timeline and correlation

- [ ] Decode a trailing record shorter than the modeled extent. A 375-byte
      `glibc-time64` tail still holds the head, session, both time words and three
      address words, but `UtmpRecord` promises a complete record, so keeping them
      requires stating which members were readable instead of returning a shorter
      `addressV6` that an absent word and a zero word would share.

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
