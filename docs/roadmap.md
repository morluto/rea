# REA roadmap

## Tool direction

REA provides inspection, capture, and comparison tools that return evidence
directly. Agents choose commands, paths, browser actions, scripts, and local
fixture servers, then compose experiments from those results. CLI and MCP must
expose equivalent behavior and preserve observations, inferences, and unknowns.

[#555](https://github.com/morluto/rea/pull/555) removed REA permission grants,
scope ceilings, elicitation, and repeated approval fields.
[#572](https://github.com/morluto/rea/pull/572) removed the replay engines,
Node characterization prepare/execute flow, and plan-only managed runtime
correlation tool. Those systems are retired roadmap items. Existing evidence
authority labels remain readable as provenance; they do not imply a current
replay executor.

Local operations use the current user's OS permissions. Input and protocol
validation, provider prerequisites, target identity, cancellation, and owned
resource cleanup remain part of each tool's contract. Setup still discloses
installation changes and requires approval before writing or installing.

## Remaining evidence and provider work

The [platform roadmap](https://github.com/morluto/rea/issues/32),
[process and Hopper fidelity tracker](https://github.com/morluto/rea/issues/48),
and [browser tracker](https://github.com/morluto/rea/issues/39) track remaining
capabilities and proof. Their scope follows direct tools and agent-composed
experiments; custom replay languages and grant systems are not completion gates.

[Inline Evidence composition](https://github.com/morluto/rea/pull/585) now returns
the complete record accepted by comparison tools. Managed inspection uses an
explicit PE/CLI target independently of the native provider selection. Comparisons
preserve unknowns when observation is incomplete, and PTY diagnostics retain the
actual loader or startup failure. Browser cleanup reports incomplete teardown
alongside the primary failure; transient documents invalidate only the affected
frame's WebMCP registrations. Real-provider and platform claims still require
their corresponding verification lanes.

## Shipped behavior

REA setup lets you select agent integration and optional Hopper installation.
It installs the bundled workflow, configures detected agents, and can save
verified paths for an existing Ghidra installation. It configures Claude Code,
Claude Desktop, Codex, Cursor, Gemini CLI, Windsurf, Devin, OpenCode, Antigravity,
GitHub Copilot CLI, Command Code, and VS Code using each client's configuration format.

Ghidra analysis supports Linux x64 and macOS x64/arm64 with Ghidra 12.1.4 and a
64-bit full JDK 21. macOS also requires the matching native decompiler. The
adapter exposes thirteen inventory operations and twelve function-analysis
operations, for 25 read-only operations total. Approved setup saves verified
installation paths in agent configurations without installing or changing
Ghidra or Java.

Real-provider verification uses host-native debug and stripped fixtures plus
a native type-layout object. A separate lane covers AArch64 ELF, PE, and
Mach-O cross-target fixtures. See [testing](testing.md) for the prerequisites
and exact commands.

Experimental Windows x64 P0 now supplies bundled Job Object ownership,
protected runtime DACLs, and handle-based admission for native x86-64 PE
applications on local NTFS. Real ordinary-user CLI/MCP verification covers
all 25 read-only operations and cleanup. The [Windows P0 guide](windows-ghidra-p0.md)
describes this boundary and unverified broader coverage.

## Ghidra maintenance boundary

Extend formats or semantics only with normalized provider-neutral contracts and
real source-owned conformance. Hopper and Ghidra pseudocode or assembly text is
not expected to match; unresolved targetless flow remains unknown. Automatic
Ghidra acquisition, if ever added, remains a separately planned and approved
related-tool change; setup must never install Java.

Maintain Windows P0 with independent DACL readback, handle-based admission,
private authenticated IPC, and Job Object assignment before provider execution.
Process capture, Hopper, and broad filesystem-sensitive workflows remain
separate Windows projects; P0 does not imply their parity.

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
