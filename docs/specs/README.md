# Feature specifications

This directory indexes proposals and implementation records. It is not a catalog
of current capabilities; use the [documentation directory](../README.md) for
current guides. Preserve original requirements and dated verification evidence
when later increments change behavior.

New feature directories use one `spec.md`, one `plan.md` and one `tasks.md`.
Some historical records have fewer artifacts; their presence or absence does not
establish completion. Do not invent past plans or completed tasks to fill gaps.
Follow [documentation ownership and authoring](../development/documentation.md#feature-lifecycle)
for new work, roadmap granularity and producer-owned contracts.

## Environment roadmaps

- [Agent environments](agent-environments/README.md)
- [Desktop application environments](desktop-app-environments/README.md)

## Other feature records

- [Core WebAssembly interface comparison (#2356)](2356-wasm-interface-comparison/spec.md) ([plan](2356-wasm-interface-comparison/plan.md), [tasks](2356-wasm-interface-comparison/tasks.md), [verification](2356-wasm-interface-comparison/verification.md))
- [Inspect APK signature schemes (v1–v3.1)](apk-signature/spec.md)
- [Documentation organization](documentation/organization/spec.md) ([plan](documentation/organization/plan.md), [tasks](documentation/organization/tasks.md), [verification](documentation/organization/verification.md))
- [V8 cached-data compilation boundaries](javascript/v8-cached-data/spec.md) ([plan](javascript/v8-cached-data/plan.md), [tasks](javascript/v8-cached-data/tasks.md))
- [Android `.note.android.ident` ELF note decoding](native/android-elf-ident-note/spec.md) ([plan](native/android-elf-ident-note/plan.md), [tasks](native/android-elf-ident-note/tasks.md))
- [Native call source coordinates](native/call-source-locations/spec.md) ([plan](native/call-source-locations/plan.md), [tasks](native/call-source-locations/tasks.md), [verification](native/call-source-locations/verification.md))
- [Go static string-header literal recovery](native/go-string-literals/spec.md) ([plan](native/go-string-literals/plan.md), [tasks](native/go-string-literals/tasks.md))
- [Windows Shell Link shortcut inspection](native/windows-shortcut/spec.md) ([plan](native/windows-shortcut/plan.md), [tasks](native/windows-shortcut/tasks.md))
- [Compound File Binary container inspection](native/compound-file/spec.md) ([plan](native/compound-file/plan.md), [tasks](native/compound-file/tasks.md))
- [NTFS $MFT and USN Journal inspection](native/ntfs-mft/spec.md) ([plan](native/ntfs-mft/plan.md), [tasks](native/ntfs-mft/tasks.md))
- [Solidity terminal metadata inspection](solidity/cbor-metadata/spec.md) ([plan](solidity/cbor-metadata/plan.md), [tasks](solidity/cbor-metadata/tasks.md), [verification](solidity/cbor-metadata/verification.md))
- [Inspect a V8 code cache container](v8/code-cache-inspection/spec.md) ([plan](v8/code-cache-inspection/plan.md), [tasks](v8/code-cache-inspection/tasks.md))
- [Deno compile executable inventory and extraction](artifacts/deno-standalone/spec.md) ([plan](artifacts/deno-standalone/plan.md), [tasks](artifacts/deno-standalone/tasks.md))
- [ELF unwind function ranges](native/elf-unwind-ranges/spec.md) ([plan](native/elf-unwind-ranges/plan.md), [tasks](native/elf-unwind-ranges/tasks.md))
- [Linux kernel build config](native/kernel-build-config/spec.md) ([plan](native/kernel-build-config/plan.md), [tasks](native/kernel-build-config/tasks.md))
- [Native initializers](native/native-initializers/spec.md) ([plan](native/native-initializers/plan.md), [tasks](native/native-initializers/tasks.md))
