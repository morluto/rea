# Android declaration comparison

## Problem

Analysts already holding two `inspect_android_package` Evidence records must
manually compare SDK, permission and component declarations. Reopening APKs is
unnecessary and can select a different observation.

## Requirements

1. `compare_android_declarations` and `compare-android-declarations` compare two
   explicitly selected, authenticated complete inspection records, inline or by
   retained Evidence reference. CLI references use `--evidence-bundle`.
2. Preserve both APK subjects, package/version declarations, engine provenance,
   source limitations and exact Evidence references. No APK or provider is opened.
3. Compare non-null SDK declarations. Null remains unknown. Show permission-list
   observations without claiming additions/removals: existing inspection Evidence
   has no independent permission-inventory coverage fact.
4. Match components by the producer's kind and resolved name only when both
   inventories are complete and the key occurs once on each side. Preserve all
   duplicate occurrences, source indices and decoded-manifest locations. Incomplete
   inventories cannot establish uniqueness or absence.
5. Report component additions/removals only within complete inventories. Compare
   exported declaration/default, permission/source and authority sets independently;
   preserve original values, null and declaration coverage. Do not infer effective
   access, maliciousness, runtime behavior, compatibility or version ordering.
6. Admit each complete mutable source before authentication or typed-schema
   copying. Borrow only authenticated immutable Evidence and validated exact
   payload facts; metadata selections remain per source.
7. Unknown exported defaults alone establish neither changed nor unchanged.
   Preserve established declaration differences and partial attribute coverage.

## Acceptance

CLI and MCP produce identical derived Evidence and preserve source retention.
Controls cover null values, authority ordering, duplicates, partial/unavailable
inventories, summary recovery, identity mismatch, tampering and cancellation.
Tests using fabricated inspection records establish comparison behavior only,
not real JADX extraction.

## Non-goals

Manifest reparsing, APK acquisition, signature verification, permission runtime
policy, component rename inference, merged/split manifests and provider changes.
