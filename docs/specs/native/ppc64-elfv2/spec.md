# PPC64 ELFv2 Power ISA 3.0 lane

## Problem and outcome

`EM_PPC64` is already classified in the provider-neutral `powerpc` family, but
the Ghidra lane refused every ELF64 file. This feature admits ELF64 `ET_EXEC`
files that declare the ELFv2 ABI, in either byte order, through the existing
Ghidra provider. `rea analyze`, `rea function`, and the MCP session tools then
work on those executables. The lane does not execute PowerPC code.

[PowerPC ELF analysis through Ghidra](../../../ghidra-ppc.md) describes the
current behavior. This directory is the feature specification, implementation
plan, and task list. The guide does not replace these files.

The 32-bit big-endian lane remains the first milestone of
[#1741](https://github.com/morluto/rea/issues/1741). This lane answers
[#12085](https://github.com/morluto/rea/issues/12085).

## Requirements

1. Admit an ELF64 `ET_EXEC` whose `e_flags` ABI field (the low two bits) is 2
   (ELFv2), for little-endian and big-endian images. The family stays
   `powerpc`. An ELF32 header that claims `EM_PPC64` stays unrecognized.
2. Import with `PowerPC:LE:64:A2ALT` or `PowerPC:BE:64:A2ALT` by byte order and
   compiler spec `default`, committed as `language_selection:
   "provider-pinned"`. A2ALT is the Power ISA 3.0 language. The G2-era
   `PowerPC:LE:64:default` and `PowerPC:BE:64:default` languages are not the
   lane default: they do not decode VSX, including the lane's `xxlor` probe.
   Passing A2ALT explicitly keeps a later loader preference from changing how
   these files decode. `REA_GHIDRA_LANGUAGE_ID` replaces the pin and is
   recorded as `language_selection: "configured"`. Readback checks the observed
   `language_id` and `compiler_spec_id`.
3. Commit `powerpc_support_lane: "elf64-elfv2-exec-isa3"` and the header facts
   (`elf_class`, `byte_order`, `type`, `flags`) on the analysis profile, so the
   interpretation is part of snapshot identity. A 32-bit profile stays
   `elf32-be-exec-generic` and is otherwise unchanged.
4. Refuse every other PPC64 shape before provider startup. Support status is
   `unsupported` with code `architecture_unsupported`, and profile resolution
   fails with `AnalysisUnsupportedTargetError`. The refused shapes are an ELFv1
   ABI (1), an undeclared ABI (0), any other value in the ABI field, `e_flags`
   bits outside that field, `ET_DYN` (shared objects and position-independent
   executables), and `ET_REL`.
5. Report an ELFv2 global entry as Ghidra models it: `classification.thunk` is
   true and `classification.thunk_target` is the local entry. Direct calls
   resolve to the callee's local entry. Pseudocode presence is a liveness
   check, not semantic equivalence.
6. Leave the 32-bit lane, Hopper, and IDA unchanged. Hopper and IDA still
   report the `powerpc` family unsupported. Windows Ghidra P0 stays PE
   x86/x86-64 only.
7. Real-provider acceptance is `npm run verify:ghidra:ppc64` on a
   caller-supplied Linux or macOS Ghidra host. Clang and the one-shot CLI run
   through the shared command owner, including the runner passed into the
   shared fixture builder. That owner is closed before the process-lineage
   check. A failed close stays registered for retry and the diagnostic
   workspace is retained. The fixtures are never executed.

## Acceptance

- Profile tests cover both byte orders' pinned language, compiler spec,
  `language_selection`, `powerpc_support_lane`, and header facts; a configured
  language replacing the pin; and refusal of the shapes above with status
  `unsupported` and `AnalysisUnsupportedTargetError`. Hopper and IDA stay
  `unsupported` for the family, including an admitted PPC64 target.
- The independent readelf boundary, probe words in file byte order, a VSX word
  whose status is `not-in-listing`, the doubleword in both byte orders, and the
  thunk fields are covered without a Ghidra-derived oracle.
- The real-provider verifier checks the observed language, the lane id, the
  thunk pair, and an `ET_DYN` refusal before provider startup, then confirms an
  empty process lineage. Compiler and CLI process groups are owned by the
  shared command runner.

## Non-goals

ELFv1 (including `.opd` function descriptors), `ET_DYN` and PIE load
verification, `ET_REL`, 32-bit little-endian PowerPC, VLE, XCOFF, executing the
image, and any new CLI command, MCP tool, or schema.
