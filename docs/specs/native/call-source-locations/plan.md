# Implementation plan

## Boundary and contract

Extend nativeCodeLocationSchema in src/domain/native/nativeCallObservation.ts.
Reuse that shape for events, breakpoint locations, backtraces and retained journal
events. Keep the field optional for older evidence and nullable for current LLDB
observations with unavailable metadata. Each inner facet can be independently
unavailable; avoid dropping a valid line number because a file path is absent.

Read SBAddress.GetLineEntry once in the existing Python _location producer. A
valid SBFileSpec supplies its displayed path without filesystem access. Convert
zero line/column to null. An invalid entry returns null. Existing estimation and
serialization budget checks already traverse the location object recursively.

## Incremental work and validation

1. Define contracts and criteria before code; add failing producer tests.
2. Extend the canonical schema and _location producer. Update existing fake
   address objects to implement the actual LLDB line-entry interface.
3. Extend provider/MCP boundary coverage and retained-journal coverage for the
   additive field; preserve omission compatibility.
4. Extend the existing real macOS verifier with source-coordinate assertions
   against its own Objective-C/C fixture built with debug information.
5. Update the native investigation guide; run Python tests, focused TypeScript
   tests, repository checks and the real verifier if host authority permits.

## Effects and compatibility

The existing LLDB operation already owns its breakpoint callbacks and process
lifecycle. This adds a metadata read within that observation. It does not introduce
target execution or a new provider beyond existing behavior. No source file is
acquired from a path in debug information. Consumers of historical evidence retain
omission; consumers of new captures see either a partial/full object or null.

## References

- https://lldb.llvm.org/python_api/lldb.SBAddress.html
- https://lldb.llvm.org/python_api/lldb.SBLineEntry.html
