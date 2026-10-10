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
```

The equivalent MCP method is `identify_flutter_build` with the same `path`.

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

- REA performs **no hash-to-SDK lookup**: mapping the snapshot hash to a
  Dart SDK release requires an external dataset and is deliberately out of
  scope for this family.
- Dart AOT snapshot _semantics_ (class and function recovery) belong to a
  later, SDK-version-specific parser; JEB's GUI Dart unit and native
  analysis of `libapp.so` cover some ground today.
- Library reads are bounded at 256 MiB each and ZIP metadata at 8 MiB;
  exceeded budgets report `resource_constraint`.

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
