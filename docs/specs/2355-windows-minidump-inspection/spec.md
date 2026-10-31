# Recorded Windows minidump inspection (#2355)

## Outcome and scope

Inspect one caller-selected Windows minidump (`MDMP`) file as recorded crash
evidence, independently of any active binary target. `inspect_windows_minidump`
/ `rea inspect-windows-minidump` is a distinct profile beside the Linux ELF core
profile of `inspect_recorded_crash`; that tool's ELF-specific result schema is
unchanged. The minidump profile reads existing bytes only: no process launch,
attach, debugger, symbol server, module/PDB acquisition or host configuration.

## Interpreted subset

Header (`MINIDUMP_HEADER`, signature `MDMP`, version low word `0xa793`) and the
complete stream directory are always decoded. Stream bodies interpreted:

| Type | Stream               | Reported facts                                                       |
| ---- | -------------------- | -------------------------------------------------------------------- |
| 7    | `SystemInfoStream`   | processor architecture/level/revision, OS version, platform          |
| 3    | `ThreadListStream`   | historical thread ID, suspend/priority, TEB, stack range, context    |
| 6    | `ExceptionStream`    | historical thread ID, code, flags, address, parameters, context      |
| 4    | `ModuleListStream`   | base, image size, checksum, timestamp, recorded name, CV/misc ranges |
| 5    | `MemoryListStream`   | start address and file range of each present region                  |
| 9    | `Memory64ListStream` | start address, size and contiguous file range of each region         |

Thread and exception contexts are always located. Register values are
interpreted for AMD64 (`PROCESSOR_ARCHITECTURE_AMD64`) contexts that cover `Rip`:
ContextFlags, MxCsr, segment selectors, EFlags, the 16 integer registers and
Rip, each bound to its original file range. x86, ARM and ARM64 contexts remain
located but uninterpreted. Other stream types (including unused type 0) are
listed with their original ranges and `unknown`/`unused` interpretation.

## Identity and unknowns

Evidence binds the stable artifact snapshot path, byte count and SHA-256.
Every reported fact carries a validated RVA/size file range. Historical thread
IDs and module names are recorded producer metadata: they never select a live
process, and they never establish current file identity or symbol matches.
Memory not described by MemoryList/Memory64List is unknown rather than absent.
A missing stream yields `null` plus an explicit limitation, never an absence
claim about the crashed process.

## Validation and bounds

The complete result is returned or the call fails; there is no partial success.
Failures are typed caller-input errors for: missing signature or version,
truncated header/directory/stream/descriptor/name/memory ranges, duplicate
interpreted stream types, non-identical overlapping directory stream ranges,
overlapping memory-content ranges (identical stack/memory-list aliases are
admitted), list counts whose declared size disagrees with the stream range
(4- or 8-byte count padding admitted) and incomplete fixed-size streams.
`max_file_bytes` (default 256 MiB, maximum 1 GiB) bounds the stable read;
`max_entries` (default 65536) bounds examined directory, thread, module and
memory descriptors. Exceeding either is a resource-constraint error. Module
names are limited to 64 KiB each. Parsing yields cooperatively and observes
cancellation; the stable read owns and releases its resources through the
existing artifact resource scope, with cleanup failures reported explicitly.

## Authority

Effects: reads existing files only. No execution, process, network, or
target/session mutation. A new parser provider identity (`rea-windows-minidump`)
is added following the portable PE resource provider pattern.

Format reference:
https://learn.microsoft.com/en-us/windows/win32/api/minidumpapiset/ns-minidumpapiset-minidump_header
