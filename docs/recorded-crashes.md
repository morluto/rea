# Recorded crash evidence

`inspect_recorded_crash` / `rea inspect-recorded-crash` inspect a caller-selected
Linux ELF64 x86-64 little-endian core independently of an active binary target.

```sh
export REA_PWNTOOLS_PYTHON=/absolute/existing/venv/bin/python
rea inspect-recorded-crash ./crash.core --json
```

The selected Python needs unchanged pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2.
REA does not install these dependencies. ELFFile/its original ELF structures and
pwntools' original Linux amd64 ctypes provide parsing and ABI layout. The adapter
adds bounds, representation preservation and lifecycle ownership.
The initial Linux note profile accepts System V/unspecified and GNU/Linux OSABI
with ABI version zero. Other declared ABIs return `unsupported_target` before
note interpretation; an unspecified OSABI alone does not prove OS origin.

## Recorded observations

- Artifact path, original SHA-256 and size; full normalized result and Evidence
  are inline through CLI and MCP.
- Original program headers and recorded segment file/memory ranges. Undumped
  memory and current executable/library identity remain unknown.
- Every note's original identity, owner/descriptor bytes and source ranges,
  including unfamiliar owners and note kinds.
- Every exact Linux CORE PRSTATUS note as a separate recorded thread, with
  historical PID, signal and lossless uint64 registers bound to source bytes.
- Signed SIGINFO number/code/errno. Initially only SIGSEGV codes 1/2 establish the
  fault-address union; other variants retain raw bytes and unknown meaning.

Historical PIDs are metadata. They never select a live process or authorize
attach/control. Missing notes do not establish absence at the crash; note
interpretation completeness and signal-thread association remain unknown.

## Optional debugger mapping context

```sh
export REA_PWNDBG_GDB=/absolute/existing/gdb
export REA_PWNDBG_GDBINIT=/absolute/unchanged/pwndbg/gdbinit.py
export REA_PWNDBG_VENV_PATH=/absolute/existing/pwndbg-venv
rea inspect-recorded-crash ./crash.core --debugger-context --json
```

MCP uses `{ "path": "/artifacts/crash.core", "include_debugger_context": true }`.
Omitting this meaningful facet requests only recorded evidence. Requested but
unavailable context returns an actionable failure; it never silently claims
debugger coverage. GDB defaults to `/usr/bin/gdb`; the plugin and virtual
environment require explicit absolute paths. Initial local verification covers
Linux x64, GDB 13.1 and unchanged pwndbg 2026.09.15.

The outer provider owns both processes and one stable core snapshot. An owned
Python launcher lowers inherited soft limits before replacing itself with GDB.
GDB starts without initfiles, auto-load, debuginfod or automatic shared-library
loading. Owned empty library search paths and caches are used, with plugin
updates disabled. Fixed package code verifies a core connection and no paired
executable before querying mapping candidates. No caller GDB command language is
exposed. The exact observed GDB/plugin version strings are retained.

Mapping names are producer display metadata, with unknown current file identity.
Map permissions are derived from reported flags; zero/unfamiliar flags leave
permissions unknown. These maps do not establish page contents or an executable
match. Core source bytes remain available independently of this enrichment.
An Evidence envelope containing these maps is `derived`; inspection without
debugger context is `observed`.

## Bounds and verification

Initial Linux x64 limits: 32 MiB input, 64 MiB decoder reply, 1 MiB diagnostics per
stage, 30 seconds owned wall deadline per stage, 3 GiB address-space soft ceiling
and 30 seconds CPU soft ceiling. Tighter inherited soft/hard limits are retained;
hard limits are not raised. Complete oversized results fail explicitly. These
process limits do not constitute a sandbox for caller-supplied engine code.

Resource exit statuses need matching private failure-branch markers. Unmarked
launcher failures retain their actual status/output and unknown resource cause.
Cancellation, output truncation and independent owned cleanup remain explicit.

`npm run verify:recorded:crash` uses source-owned fixtures and caller-supplied
GDB/Python/pwndbg/strace. Fixture generation explicitly launches its owned test
program; subsequent inspection only reads the resulting core. Real acceptance
checks recorded threads, high registers, missing/malformed notes, opaque owners,
CLI/MCP parity, optional debugger context and historical PID collision with an
owned live sentinel. Original inputs and host configuration remain unchanged.
