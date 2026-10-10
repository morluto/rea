# Flutter build identification

REA identifies a Flutter app's build facts by **pure parsing** of its APK:
the Dart VM snapshot hash, per-ABI library digests, the engine's GNU
build-id, and any labeled version strings. No engine, no tool installation,
no execution, and no external lookups — this family answers "which Dart SDK
build is this, and what exactly is in the payload?" before any deeper
native analysis.

This is the triage step for Flutter reversing: the snapshot hash is the
artifact that maps to a Dart SDK release through an external dataset (such
as the one reFlutter maintains), and knowing the SDK version is what makes
SDK-layout-specific snapshot parsers applicable.

## Answer an analyst question

```sh
rea identify-flutter-build /targets/Example.apk
rea inspect-dart-aot /targets/Example.apk
rea inspect-dart-aot /targets/Example.apk --abi armeabi-v7a
```

The equivalent MCP methods are `identify_flutter_build` (with `path`) and
`inspect_dart_aot` (with `path` and an optional `abi`; the default picks
arm64-v8a, then x86_64, then the first available ABI).

## What the AOT inspection returns

`inspect_dart_aot` reads one ABI's `libapp.so` in full and reports:

- **Snapshot sections** — the four `_kDart*Snapshot*` symbols located
  through the ELF **dynamic symbol table** (ELF32 and ELF64, little-endian,
  every read bounds-checked), each with file offset, size, and — for data
  sections, which carry the `f5f5dcdc` magic — the parsed header kind and
  length. A payload without exported snapshot symbols is refused rather
  than guessed at.
- **The snapshot hash**, agreeing with `identify_flutter_build`.
- **A string-pool projection from the isolate data section**: distinct
  `package:` source URIs (the app's own and its dependencies' Dart files —
  a dependency inventory), `dart:` SDK URIs (which SDK libraries the app
  uses), and identifier-shaped tokens, each bounded with counts and
  `coverage: "partial"` when truncated. On the reference target this
  surfaces 756 package URIs and 201 dart URIs.

## Interpret the result

- **`flutter_detected`** is true when any `lib/<abi>/libapp.so` exists. A
  negative answer reports complete coverage: absence is an answer.
- **`snapshot_hash`** is the Dart build hash observed 20 bytes after each
  snapshot magic (`f5 f5 dc dc`) inside `libapp.so`. The vm and isolate
  sections are both read and cross-checked: `snapshot_hash_sources` counts
  the sections found, and when they **disagree** the distinct values are
  kept in `snapshot_hash_candidates` with `snapshot_hash: null` and
  `coverage: "partial"` rather than silently picking one.
- **`libflutter` facts** are per-ABI observations: byte size, SHA-256
  digest, the GNU build-id note, and any _labeled_ strings the build
  carries. Release engine builds often strip the `Dart VM version` string —
  absence is reported as `null`, not guessed. Android clang/LLVM toolchain
  lines are reported verbatim as build provenance.
- **`coverage: "partial"`** also appears when an ABI carries `libapp.so`
  without `libflutter.so` (or vice versa).
- The APK itself is digested before parsing, so `target.sha256` binds the
  observation to the exact input.

## Limits

- **Owned snapshots.** Both operations copy the admitted APK into a
  provider-owned, read-only snapshot before digesting and parsing, so a
  concurrently modified original cannot mix into one observation; failed
  snapshot cleanup is retained and retried on `close()`.
- **Bounded reads.** Library reads are bounded at 256 MiB each and ZIP
  metadata at 8 MiB; the AOT image buffer is allocated at exactly the
  declared size before reading. Exceeded budgets report
  `resource_constraint`.
- REA performs **no hash-to-SDK lookup**: mapping the snapshot hash to a
  Dart SDK release requires an external dataset and is deliberately out of
  scope for this family.
- The AOT string pool is a **byte-pattern projection, not deserialized
  cluster semantics**: typed class and function recovery requires an
  SDK-specific parser (the snapshot layout changes per release — exactly
  why the hash is the key), and `class_like_tokens` include incidental
  matches. JEB's GUI Dart unit and native analysis of `libapp.so` cover
  some ground today.

## Real verification

`npm run verify:flutter -- --apk PATH [--plain-apk PATH]` runs the
identification against a real Flutter APK and, optionally, a non-Flutter
APK for the negative check. Record: Flutter Gallery 2.9.2 (112 MB, three
ABIs) — every ABI reports the same agreeing hash
`65817c30a78bb44c3dc3771876b6010a` from two snapshot sections, per-ABI
engine build-ids, no labeled Dart version (as expected for a release
engine), and the Android clang toolchain line; a plain aapt2-built APK
reports not-detected with complete coverage. Scanner goldens in the test
suite come from the same libraries.
