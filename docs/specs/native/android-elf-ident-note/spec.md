# Android `.note.android.ident` ELF note decoding

## Problem and outcome

Android NDK shared libraries and executables linked with Bionic `crtbegin_so.o`
or `crtbrand.S` embed an ELF note with `owner === "Android"` and `n_type === 1`
(`NT_ANDROID_TYPE_IDENT`) inside `.note.android.ident` (`SHT_NOTE` and/or
`PT_NOTE`). Legacy Android NDK (`< r14`) and unbranded platform builds store a
4-byte `uint32_t android_api` descriptor, while modern NDK (`r14+`) builds
store a 132-byte (or extended `>= 132`-byte) descriptor containing
`uint32_t android_api` (`0..4`), `char ndk_version[64]` (`4..68`), and
`char ndk_build_number[64]` (`68..132`).

Previously, `inspect_elf_notes` / `inspect-elf-notes` mapped only `GNU` and
`CORE` note owners, leaving `Android` type `1` entries as `type_name: "unknown"`
with `descriptor.hex: null` for 132-byte notes (above the 64-byte inline hex
preview ceiling). Extend `inspect_elf_notes` to decode `NT_ANDROID_TYPE_IDENT`
into `type_name: "android_ident"` and a nullable `android` object across
32-/64-bit and little-/big-endian ELF targets without executing the image.

## Requirements

- Map `owner === "Android"` and `type === 1` to `type_name: "android_ident"`;
  other `Android` note types remain `type_name: "unknown"` with `android: null`,
  and non-`Android` owners keep `android: null`.
- Decode 4-byte `NT_ANDROID_TYPE_IDENT` descriptors in the ELF image's byte
  order as `{ android_api, ndk_version: null, ndk_build_number: null }`.
- Decode `>= 132`-byte `NT_ANDROID_TYPE_IDENT` descriptors in the ELF image's
  byte order when both 64-byte fixed slots (`4..68` and `68..132`) contain
  printable ASCII (`0x20..0x7e`) terminated by `0x00` and padded solely with
  `0x00` through the end of each 64-byte slot.
- Degrade truncated (`0..3` or `5..131` bytes), unterminated, control-byte, or
  non-zero-padded `NT_ANDROID_TYPE_IDENT` descriptors to `android: null` while
  preserving raw note header fields, descriptor SHA-256, and `<= 64`-byte hex
  preview.
- Account for fixed-slot scanning (`128` bytes cached per descriptor slice in
  `TextBudget.scans`) and retained `ndk_version` / `ndk_build_number` text in
  `TextBudget.used` under the shared `max_file_bytes` ceiling.

## Acceptance

Domain, parser, MCP boundary, and CLI/stdio-MCP acceptance tests cover
little-endian ELF64 (`aarch64`, `x86_64`) and big-endian ELF32/ELF64 images
across 132-byte, 152-byte extended, and legacy 4-byte descriptors, unknown
`Android` note types, malformed/truncated/non-ASCII descriptors, and shared
`TextBudget` scan, scan-cache, and retained-string limits.

## Out of scope

Decoding other `NT_ANDROID_*` note types (such as `NT_ANDROID_TYPE_MEMTAG` or
`NT_ANDROID_TYPE_KUSER`), executing target binaries, or invoking external
disassemblers.
