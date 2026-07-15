# Installation roadmap

## Shipped behavior

REA setup currently configures the capabilities that exist today: its bundled
skill, detected agent integrations, optional Hopper provider, and validated
bring-your-own Ghidra paths. It detects
Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Windsurf, and Devin. The
first six have documented local MCP configuration boundaries and can be updated
additively; Devin is reported but left unchanged.

The Ghidra foundation supports Linux x64 with exact Ghidra 12.1.2 and a 64-bit
full JDK 21. Doctor validates those coordinates; approved setup propagates them
to MCP registrations without installing or modifying either dependency. REA's
packaged Java bridge then proves an isolated read-only headless import,
post-analysis handshake, and complete cleanup. The provider intentionally
declares no binary operation capabilities in this foundation release.

## Next Ghidra milestone

Admit Ghidra read-only capabilities individually: start with program identity,
procedures, strings, symbols, memory blocks, address/name resolution, and
bounded search; then add function details, decompilation, assembly, calls, xrefs,
and CFG. Every claim requires normalized provider-neutral semantics and real
source-owned conformance. Hopper and Ghidra pseudocode text is not expected to
match. Automatic Ghidra acquisition, if ever added, remains a separately
planned and approved related-tool change; setup must never install Java.

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
