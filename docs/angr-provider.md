# angr provider

REA adapts the MCP server bundled with [angr](https://github.com/angr/angr) into its native analysis tools. angr is an open-source binary analysis framework; its `angr.mcp` module exposes CFG recovery, function inventory, disassembly, decompilation, strings, and cross-references over MCP. Install angr with its MCP extra using angr's own instructions. REA does not install, upgrade, or bundle angr or Python.

Select `angr` once through `REA_ANALYSIS_PROVIDER`, the CLI's `--provider angr`, or MCP's `open_binary.provider_id`. No provider startup occurs during discovery.

## Give REA an interpreter for headless analysis

The simplest registration names a Python interpreter whose environment contains angr with the `llm` extra (which provides `fastmcp`):

```bash
python3 -m venv ~/angr-venv
~/angr-venv/bin/pip install "angr[llm]"
export REA_ANGR_PYTHON=~/angr-venv/bin/python
export REA_ANALYSIS_PROVIDER=angr
rea function /absolute/path/to/program main --json
rea decompile /absolute/path/to/program main --json
```

`REA_ANGR_PYTHON` must be an absolute path to an existing interpreter file. REA expands it to the owned stdio registration `python -m angr.mcp --transport stdio`, starts that process for each analysis session, loads the selected binary without shared libraries, recovers a normalized CFG with data references, and closes the project and process when the session ends. The original binary is never executed or written.

## Register an explicit MCP command or endpoint

`REA_ANGR_MCP_CONFIG` names a JSON file with either a stdio command or a local Streamable HTTP endpoint. When both settings are present, the file wins.

```json
{
  "command": "/absolute/path/to/python",
  "args": ["-m", "angr.mcp", "--transport", "stdio"],
  "env": { "PYTHONUTF8": "1" }
}
```

A stdio command defaults to **headless** mode: REA owns the process and its project. An HTTP endpoint defaults to **attached** mode and cannot be owned:

```json
{
  "url": "http://127.0.0.1:8000/mcp",
  "mode": "attached"
}
```

Start that server yourself with `python -m angr.mcp --transport http --port 8000`, or use the MCP server built into angr management when it is listening on loopback. Only `localhost`, `127.0.0.1`, and `[::1]` endpoints without URL credentials are accepted. Optional `headers` are sent on every request and redacted from diagnostics. An `mcpServers` envelope with an `angr` entry is also accepted.

Optional keys on either form: `timeoutMs` (per request, default 300000), `startupTimeoutMs` (project load and CFG recovery, default 600000), and `autoLoadLibs` (default `false`).

## What each mode observes

In both modes, REA loads its own project on the server and checks that the server reports the selected target path before analysis. Each REA session owns exactly one angr project and closes it on `close_binary`; the headless process ends with the connection.

In attached mode the server is shared with other clients. Results reflect its current knowledge base, including renames or type edits applied by other agents through angr's own edit tools, and are reported as live Evidence that is never replayed from analysis snapshots. Closing a REA session closes only its own project. If another client closes that project, the next REA request fails with the upstream reason.

## Supported targets and operations

angr admits ELF, PE, and thin Mach-O executables and shared libraries on every architecture its loader and lifter support. REA declines universal Mach-O containers, headerless raw binaries, and 16-bit DOS inputs for this adapter; use Hopper or Ghidra for those.

This adapter provides function and string inventory and search, function lookup, assembly, pseudocode, callers, callees, data xrefs, instruction windows, and function dossiers. Observed facts have these boundaries:

- Function bodies come from angr's recovered basic blocks and are reported as merged inclusive ranges.
- Callers and callees come from angr's call graph, fetched once per session. Unresolved indirect calls are absent, so relationship coverage is reported as partial.
- `xrefs` returns the instruction addresses of data references recorded during CFG recovery. Call and jump references are not included; use `procedure_callers`.
- Pseudocode is angr's decompiler output. Functions above angr's complexity limits fail with the upstream reason; a function dossier retains assembly and relationships and reports the missing pseudocode as a limitation.
- Signatures are angr's recovered prototypes when present. Locals, comments, typed reference flags, referenced strings and names, and basic-block successors are not reported.
- Symbolic execution, emulation, and angr's edit tools are not exposed.

The provider version identifies REA's adapter. The connected server's `serverInfo` is retained in raw Evidence; it reports the MCP framework version, not necessarily the angr release.

## Connect an agent once

Add the registration to the **REA** MCP entry's environment:

```json
{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ["-y", "rea-agents@<version-with-angr>", "mcp"],
      "env": {
        "REA_ANALYSIS_PROVIDER": "angr",
        "REA_ANGR_PYTHON": "/absolute/path/to/angr-venv/bin/python"
      }
    }
  }
}
```

`rea setup` publishes a valid `REA_ANGR_PYTHON` or `REA_ANGR_MCP_CONFIG` into agent registrations after `rea doctor --provider angr --json` reports the registration as valid. Doctor checks only the registration; the angr installation, its MCP extra, and target loading are checked when analysis starts.

After reconnecting, call:

```json
{"name":"open_binary","arguments":{"path":"/absolute/path/to/program","provider_id":"angr"}}
{"name":"analyze_function","arguments":{"procedure":"main"}}
{"name":"search_strings","arguments":{"pattern":"license"}}
{"name":"close_binary","arguments":{}}
```

## Verify a real installation

`npm run verify:angr -- --target /absolute/path/to/program --procedure main` runs the production CLI and MCP server against the configured angr registration. See [testing](testing.md#angr-mcp-adapter).
