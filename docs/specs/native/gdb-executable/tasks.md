# Tasks

- [x] Add the optional contract/CLI input and forward it to GDB startup (R1).
- [x] Share stable launch-file observation with Rizin and retain failed cleanup
      through retry and shutdown (R2, R5).
- [x] Load after automatic loading is disabled, then publish readiness (R3).
- [x] Bind ordinary and partial Evidence to initial selection and provenance;
      preserve unknown omission and later-command semantics (R4).
- [x] Verify public MCP/CLI behavior, refused/cancelled loading, cleanup retry,
      and the affected existing lifecycle suites (R1–R5).
- [x] Run a real Linux GDB load-only workflow and record its limits; update
      product documentation and required static/generated checks (acceptance).

## Verification (2026-11-16)

- Serial typecheck/lint and architecture guards passed.
- Ten focused files passed 301 tests before the completed-hash review fix, including advertised-schema/client
  admission, CLI selection, late loading/cancellation, retained file and
  debugger cleanup, and existing GDB/Rizin lifecycle behavior.
- Temporarily permitting MI2 retry after file-load refusal made the dedicated
  regression fail with two loads instead of one; source was restored exactly.
- A public stdio MCP workflow with GNU GDB 13.1 on Linux loaded an owned ELF
  whose path contained spaces and quotes. Evidence matched its SHA-256,
  Python automatic loading was off, its execution marker remained absent,
  and the session closed successfully. Native Rizin was not exercised.
- Six additional GDB/Rizin cases preserve completed hash facts when final close
  fails, is cancelled, or both, through public error projection and cleanup retry.
  All six fail against the pre-fix shared observer; the twelve-case file passed
  with the fix. A broader rerun passed 306/307 tests; the remaining fixture
  observed an empty asynchronous signal marker. Publishing that marker
  synchronously removed the observation race, and both affected files passed
  all 32 tests on the final source. Final CI is recorded in the PR.
- Documentation/generated checks and final native recheck are recorded in the
  PR validation evidence.
