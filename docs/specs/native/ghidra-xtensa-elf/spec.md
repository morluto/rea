# Xtensa ELF analysis through Ghidra

This specification was written on 14 November 2026, after the implementation in
[#7486](https://github.com/morluto/rea/pull/7486), when review asked for the
feature directory. It records the requirements that the PR and
[the lane guide](../../../providers/ghidra-xtensa.md) already state; it does not
reconstruct an earlier plan.

## Problem and outcome

ESP-IDF links ESP32, ESP32-S2 and ESP32-S3 applications as `EM_XTENSA` (94) ELF
images. REA refused them before any provider ran ("unsupported ELF architecture:
e_machine 94"), although Ghidra 12.1.4 ships `Xtensa:LE:32:default`. Go and Rust
reports named the machine `elf-machine-94`. Issue
[#3483](https://github.com/morluto/rea/issues/3483) asks for ESP32 support.

The outcome: an `EM_XTENSA` image resolves as the provider-neutral `xtensa`
family, and Ghidra analyzes little-endian ELF32 `ET_EXEC` images that declare
the windowed ABI and PC-relative literals, through a pinned language and
compiler specification. Every other shape gets a specific refusal.

## Requirements

- Retain `EM_XTENSA` as the `xtensa` family with the raw ELF class, byte order,
  `e_type` and `e_flags`. Do not recognize `EM_XTENSA_OLD` (`0xabc7`).
- Read the ABI and literal addressing that GNU as and ld declare in the
  `.xtensa.info` section's one `Xtensa_Info` note (`ABI=0` windowed, `ABI=1`
  call0; `USE_ABSOLUTE_LITERALS=0` PC-relative, `1` from `LITBASE`) during
  target resolution. Never infer either from the family name.
- Leave both declarations unknown, without failing target resolution, when the
  section or note cannot be read: no section table, an unreadable or duplicate
  section name, a compressed section, a malformed or unterminated note, or
  non-zero bytes after the text's terminating NUL. Report a fixed 4096-byte
  bound on the note, and a fixed 16 MiB budget on section names, as structured
  refusals that say this release has no runtime override.
- Read section headers in bounded batches and keep only the `.xtensa.info`
  match, so a large section table costs reads, not retained records.
- Admit the Ghidra lane only for ELF32, little-endian, `ET_EXEC`, `e_flags`
  within `EF_XTENSA_MACH`, `XT_INSN` and `XT_LIT`, machine field 0, `ABI=0` and
  `USE_ABSOLUTE_LITERALS=0`. Refuse every other shape with a reason that names
  the offending declaration.
- Pin `Xtensa:LE:32:default` with compiler specification `default`, record the
  selection, and fail a session whose import reports another language or
  compiler specification. A conflicting caller override is a configuration
  error; an override that names only the pinned language keeps `default`.
- State the verified scope and Ghidra 12.1.4's Xtensa limitations in results.
- Spell machine 94 `xtensa` in the Evidence subject, snapshot target and live
  target summary enums, and in Go, Rust and native-export reports.

## Acceptance

- Domain and boundary tests cover the family, the `.xtensa.info` reader and
  every malformed-note case, the gate and each refusal, the pin and post-import
  check, the override, the summary schema, and Go and Rust spelling.
- `npm run verify:ghidra:xtensa` passes on real Ghidra 12.1.4 (`"mocked":
  false`, cleanup complete). It writes a windowed fixture from annotated bytes,
  checks the header and declarations against `readelf`, instruction decoding,
  the `call8` target and `l32r` literal, decompiled dataflow, CLI and MCP parity,
  snapshot reopen, five header-mutated refusals, unchanged source bytes and
  owned cleanup. With `REA_XTENSA_CC`, it also checks a compiled C fixture.

## Out of scope

- The call0 ABI (ESP8266), absolute literals (`USE_ABSOLUTE_LITERALS=1`),
  big-endian cores and ELF64.
- Raw images, ESP application images, flash images and partition tables.
- Working around Ghidra 12.1.4's Xtensa gaps (`SALT`/`SALTU`, FLIX bundles,
  ESP32-S3 `ee.*` instructions, zero-overhead loops, register-window
  decompilation, unimplemented relocations).
- Executing Xtensa code or rehosting firmware. Hopper, IDA and Kuna do not
  admit Xtensa, and Windows Ghidra P0 refuses ELF targets.
