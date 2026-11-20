# Tasks

- [x] Define the single-feature scope, contract, and implementation plan.
- [x] Admit ELF64 `ET_EXEC` ELFv2 in both byte orders, and refuse ELFv1, an
      undeclared ABI, other `e_flags` bits, `ET_DYN`, and `ET_REL`.
- [x] Pin `PowerPC:LE:64:A2ALT` and `PowerPC:BE:64:A2ALT` as `provider-pinned`,
      and record `REA_GHIDRA_LANGUAGE_ID` as `configured`.
- [x] Commit `powerpc_support_lane: "elf64-elfv2-exec-isa3"` and the header
      facts on the analysis profile.
- [x] Cover admission, the configured language, refusals, and Hopper/IDA
      decline in `src/ghidra/GhidraPowerPcProfile.test.ts`.
- [x] Cover the readelf boundary, probe words, a `not-in-listing` VSX word, the
      doubleword, and the thunk fields in the PowerPC conformance checks.
- [x] Add `verify:ghidra:ppc64`, and run its compiler and CLI through the shared
      command owner, closed before the process-lineage check.
- [x] Update the PowerPC guide and index this feature record.
- [x] Record the contributor's Ghidra 12.2 Linux x86-64 runs of the PPC32 and
      PPC64 verifiers in [the pull request](https://github.com/morluto/rea/pull/12517).
      Those runs preceded the verifier ownership changes.
- [ ] Rerun both verifiers on a real Ghidra installation after the ownership
      changes. A macOS real-provider run is also unrecorded.
