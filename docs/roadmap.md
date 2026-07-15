# Installation roadmap

## Shipped behavior

REA setup currently configures the capabilities that exist today: its bundled
skill, detected agent integrations, and optional Hopper provider. It detects
Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Windsurf, and Devin. The
first six have documented local MCP configuration boundaries and can be updated
additively; Devin is reported but left unchanged.

## Next provider milestone

Ghidra is the accepted direction for REA's second deep static-analysis provider,
but it is not shipped yet. The first implementation is planned as a bring-your-
own Ghidra and Java installation with read-only headless analysis, the shipped
explicit provider selection and target binding, isolated temporary projects,
and truthful unavailable capabilities. Setup must not install Java. Automatic
Ghidra acquisition, if added later, must remain a separately planned and
approved related-tool change.

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
