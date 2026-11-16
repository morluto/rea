# Inspect a V8 code cache container

This specification records an implementation increment and its original problem
statement. For current behavior and limitations, see the
[current guide](../../../guides/javascript/v8-code-cache.md).

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
  `vm.compileFunction`, and neither bit means `unknown`. The unflagged case is not
  `vm.Script` by inference — whether V8 marks a function cache is a build detail. A
  `vm.compileFunction` cache reads `0x20000004` for a 4-unit source on Node 24.22.1 and
  `0x00000004` on Node 22.23.4, so an unflagged word could be either producer. The
  observed word stays in `header.fields` for a caller that trusts a specific build
  fingerprint.
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

- The `vm.Script` producer word and its retained strings come from output this suite
  generates through `vm.Script.createCachedData()`, and the `vm.compileFunction` case
  compiles through `vm.compileFunction` for the same reason.
- The `vm.SourceTextModule` producer bit is checked by setting the measured bit on a real
  `vm.Script` cache rather than by compiling through `vm.SourceTextModule`, so that case
  covers the bit's meaning and not a cache from that producer.
- The CLI, MCP, absolute-path and decimal-argument boundary contracts have their own
  tests.
- The budget tests call `observationBudgetRecovery` and assert its structured facts — the
  boundary reached and which knob may move. `observationBudgetRemediation` renders that
  struct into a sentence, so it is held to the struct rather than to its wording: the
  sentence must not advise a knob the struct closed, and must mention a smaller artifact
  exactly when the struct requires one. Rewording stays free; wrong advice does not.
