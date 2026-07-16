# Installation roadmap

## Shipped behavior

REA setup currently configures the capabilities that exist today: its bundled
skill, detected agent integrations, optional Hopper provider, and validated
bring-your-own Ghidra paths. It detects
Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Windsurf, and Devin. The
first six have documented local MCP configuration boundaries and can be updated
additively; Devin is reported but left unchanged.

The Ghidra foundation supports Linux x64 with exact Ghidra 12.1.2 and a 64-bit
full JDK 21. An experimental Windows x64 P0 admits approved native x86-64 PE
applications through the same 18-operation Java bridge. Doctor validates those coordinates; approved Linux/macOS setup propagates them
to MCP registrations without installing or modifying either dependency. REA's
packaged Java bridge then proves an isolated read-only headless import,
post-analysis handshake, complete cleanup, ten admitted read-only inventory
operations, and eight function-analysis operations. Real source-owned x86-64
debug/stripped ELF, AArch64 ELF, PE, and Mach-O fixtures cover program,
procedure, string, symbol, external/thunk, memory, resolution, search,
decompilation, assembly, calls, typed references, xrefs, and CFG semantics.
Hosted Windows CI covers build, package, target admission, transport, and
lifecycle seams; a controlled self-hosted workflow covers the real Ghidra P0
claim.

## Ghidra maintenance boundary

Extend formats or semantics only with normalized provider-neutral contracts and
real source-owned conformance. Hopper and Ghidra pseudocode or assembly text is
not expected to match; unresolved targetless flow remains unknown. Automatic
Ghidra acquisition, if ever added, remains a separately planned and approved
related-tool change; setup must never install Java.

Before Windows advances beyond P0, add current-user-only DACL creation and
readback, handle-based reparse-point-safe path authority, a DACL-protected IPC
backend, and Job Object assignment before provider execution. Process capture,
controlled replay, Hopper, and broad filesystem-sensitive workflows remain
separate Windows projects rather than implied parity.

## Capability-selective setup

After REA ships at least two real optional toolchains, setup can evolve into a
capability-oriented wizard. It may ask whether the operator wants to investigate
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
