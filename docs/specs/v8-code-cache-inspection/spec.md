# Inspect a V8 code cache container

## Outcome

A bytenode `.jsc`, the bytes `vm.Script.createCachedData()` writes, and a code cache
carried inside a Node single-executable application or an Electron application are all
opaque today: the analysis reports the containing file and nothing about the cache. An
analyst has to install bytenode, guess a V8 version, and run the file to learn anything,
which executes attacker-controlled code and changes the state under study.

`rea inspect-v8-code-cache <path> [--minStringBytes <n>]` reads one explicitly selected
container as static bytes and reports its producer, the strings it retains above a
threshold, and the recoverable source metadata, without executing the file, starting a
V8 runtime, installing bytenode, or invoking a decompiler. The same facts are available
through the `inspect_v8_code_cache` MCP tool.

## Requirements

- The reader accepts a file whose first words describe a V8 code cache header; anything
  else is refused before the payload is walked, so an unrelated file cannot be read as a
  cache by accident.
- The producer is decided from the header's producer bits, not from the file extension:
  a module bit means `vm.SourceTextModule`, a compile-function bit means
  `vm.compileFunction`, and neither means `vm.Script`. All three were measured on Node
  24.22.1.
- Retained strings are reported above the caller's byte threshold, with
  `--minStringBytes` bounded so a pathological threshold cannot make the read unbounded.
- Observation is bounded by a budget that reports which bound it hit and how to raise it,
  rather than silently truncating.
- The container's file location is reported as given, and the payload is never written
  back or repaired.

## Non-goals

- Decoding the payload back into source. The container's bytecode is version-specific and
  the tool does not attempt to reconstruct source from it.
- Executing the container to obtain runtime facts.
- Recognising an encrypted or compressed wrapper around a cache.

## Verification

- Producer detection and payload retention are covered by parser tests built from real
  `vm.Script`, `vm.compileFunction` and `vm.SourceTextModule` output.
- The CLI, MCP, absolute-path and decimal-argument boundary contracts have their own
  tests.
- The budget remediation sentence is compared with its owning formatter, not with a
  frozen string.
