# Installation roadmap

## Shipped behavior

REA setup lets you select agent integration and optional Hopper installation.
It installs the bundled workflow, configures detected agents, and can save
verified paths for an existing Ghidra installation. It detects Claude Code,
Claude Desktop, Codex, Cursor, Gemini CLI, Windsurf, and Devin. The first six
can be configured; Devin is reported but left unchanged.

Ghidra analysis supports Linux x64 and macOS x64/arm64 with Ghidra 12.1.4 and a
64-bit full JDK 21. macOS also requires the matching native decompiler. The
adapter exposes ten inventory operations and twelve function-analysis
operations, for 22 read-only operations total. Approved setup saves verified
installation paths in agent configurations without installing or changing
Ghidra or Java.

Real-provider verification uses host-native debug and stripped fixtures plus
a native type-layout object. A separate lane covers AArch64 ELF, PE, and
Mach-O cross-target fixtures. See [testing](testing.md) for the prerequisites
and exact commands.

Windows Ghidra operations remain unavailable until REA implements verified
Job Object process ownership, private runtime DACLs, and reparse-safe path
admission. Windows package and adapter tests do not establish a usable real
Ghidra session. The [Windows P0 guide](windows-ghidra-p0.md) describes the
intended boundary and remaining requirements.

## Ghidra maintenance boundary

Extend formats or semantics only with normalized provider-neutral contracts and
real source-owned conformance. Hopper and Ghidra pseudocode or assembly text is
not expected to match; unresolved targetless flow remains unknown. Automatic
Ghidra acquisition, if ever added, remains a separately planned and approved
related-tool change; setup must never install Java.

Before enabling Windows Ghidra operations, add current-user-only DACL creation and
readback, handle-based reparse-point-safe path authority, a DACL-protected IPC
backend, and Job Object assignment before provider execution. Process capture,
Hopper, and broad filesystem-sensitive workflows remain separate Windows
projects rather than implied parity.

## Capability-selective setup

Setup already lets users select agent integration and Hopper installation.
Once REA supports installing additional analysis tools, it can expand these
choices to match the work a user wants to do. It may ask whether the operator wants to investigate
native binaries, websites, mobile applications, firmware, or runtime protocols,
then propose only the tools needed for the selected work.

That future installer must preserve the current safety boundary:

- detect and reuse existing tools;
- disclose every source, destination, license, command, and system effect;
- prefer user-local installation;
- install only explicitly selected toolchains;
- require tool-specific authorization for unattended system changes;
- verify each installed tool before reporting readiness.

No placeholder tool choices or speculative installer registry are implemented
until another supported toolchain makes the abstraction concrete.
