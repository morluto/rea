# Bind a GDB session to its selected load file

Scope: [#11581](https://github.com/morluto/rea/issues/11581), approved in the
2026-11-16 maintainer handoff and recorded in
[#11682](https://github.com/morluto/rea/issues/11682#needs-an-owner-decision).

`start_gdb_session` currently records an unknown target because it accepts no
file. An analyst who selects a file at startup needs subsequent command Evidence
to identify that initial file, separately from the current inferior.

## Requirements

1. Accept an optional absolute `executable` path on `start_gdb_session`.
   The one-shot `debug-with-gdb` command exposes the same selection as
   `--executable`, accepting a caller-relative local path.
2. Hash the selected regular file with the existing stable-file owner before
   GDB loads it. Share hash outcome and failed-close interpretation with Rizin.
   A physical hash failure leaves identity unknown with its reason; cancellation
   and outstanding descriptor cleanup fail startup and retain cleanup ownership.
   If hashing completed before final close failed or was cancelled, preserve its
   SHA-256 and byte count in the startup error, including after cleanup retry.
3. Disable automatic loading before issuing the MI file-load request. Publish
   readiness only after the load completes successfully. Loading does not issue
   an inferior run, attach or shell command.
4. Bind command and partial startup Evidence to the initial file observation.
   Preserve original and absolute startup paths as provenance. Later console
   loads and attaches do not rebind it. Omission preserves an unknown target.
5. Preserve cancellation, startup reservations, failed-start cleanup retention,
   cleanup retry and shutdown draining through the new stages.

## Acceptance

Public MCP and CLI workflows expose the input and retain the initial file hash
in Evidence. A real Linux GDB load of an owned executable leaves its execution
marker absent. Deterministic provider tests cover refused loading, cancellation
during loading and failed cleanup retry. Existing GDB lifecycle and Rizin hash
cleanup regressions continue to pass. Report simulated and real-provider
verification separately.

This increment leaves unrestricted `gdb_console` authority and the session
identity rules in the [target identity ADR](../../../adr/evidence/target-identity.md)
in place.
