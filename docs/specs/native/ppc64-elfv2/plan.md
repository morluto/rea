# Implementation plan

## Boundary and contract

`src/ghidra/GhidraPowerPcProfile.ts` owns PPC64 admission
(`ghidraPowerPcUnsupportedReason`), the pinned language
(`ghidraPowerPcLanguage`), and the profile facts
(`ghidraPowerPcProfileParameters`). `ghidraPinnedLanguage`, the analysis
profile, and the processor gate already route `powerpc` through these
functions. Callers keep the selected inputs. No CLI or MCP schema changes.

The optional verifier `scripts/verify-real-ghidra-ppc64.mjs` obtains its
runner from `createVerifierCommands`. Clang launches, including those inside
`buildPowerPc64Fixture`, and the one-shot CLI use that runner. The verifier
closes the owner before `completeVerifierRun`. A failed close stays registered
on the fixture for retry, and the diagnostic workspace is retained.

## Incremental work and validation

1. Admit ELF64 `ET_EXEC` ELFv2 in both byte orders and refuse the other PPC64
   shapes from the PowerPC profile, without changing the 32-bit lane.
2. Pin `PowerPC:LE:64:A2ALT` or `PowerPC:BE:64:A2ALT` with compiler spec
   `default`, and commit `powerpc_support_lane: "elf64-elfv2-exec-isa3"` with
   the header facts.
3. Extend the profile tests for admission, a configured replacement language,
   the refused shapes, and Hopper/IDA decline.
4. Extend the independent readelf and probe checks for the 64-bit fixture,
   including a VSX word that is not in the listing and the global-entry thunk
   fields.
5. Add `verify:ghidra:ppc64`. Own its compiler and CLI processes with the
   shared command runner, and describe the lane in the PowerPC guide.

## Effects and compatibility

ELF64 `ET_EXEC` ELFv2 targets move from refused to supported. Existing 32-bit
profiles are unchanged. The import stays read-only: the lane does not execute
the image, and Hopper, IDA, and Windows Ghidra P0 are unchanged. The verifier
adds no process authority beyond the shared command owner.
