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

Optional keys on either form: `timeoutMs` (per request, default 300000), `startupTimeoutMs` (project load and CFG recovery, default 600000), `autoLoadLibs` (default `false`), and `flavor` (a session-wide decompilation flavor applied after load; see below).

## What each mode observes

In both modes, REA loads its own project on the server and verifies that it is the selected target before analysis. An angr that reports the loaded file's SHA-256 is checked by digest, which also covers a server whose filesystem view differs from REA's host (a container or bind mount). An older angr without a digest is checked by path, so it must share this host's filesystem, and the Evidence carries a limitation saying so. Each REA session owns exactly one angr project and closes it on `close_binary`. In headless mode the owned process ends with the connection (the transport ends stdin, then sends SIGTERM and SIGKILL); if `close_project` itself fails, REA still ends the process, since an in-memory project cannot outlive it. In attached mode a failed `close_project` retains the project id as an incomplete-cleanup resource for a later `close_binary` retry.

In attached mode the server is shared with other clients. Results reflect its current knowledge base, including renames or type edits applied by other agents through angr's own edit tools, and are reported as live Evidence that is never replayed from analysis snapshots. Closing a REA session closes only its own project. If another client closes that project, the next REA request fails with the upstream reason.

## Supported targets and operations

REA passes every executable kind to angr and reports angr's loader errors unchanged. angr admits ELF, PE, and Mach-O executables and shared libraries on every architecture its loader and lifter support. For a universal Mach-O, REA passes the selected slice's architecture so angr loads that slice; for a headerless raw binary it passes `backend: blob`, the architecture, and the entry point as both image base and entry, matching REA's raw-image mapping. These loader options need an angr whose `load_binary` accepts them; an older angr fails with a message naming the needed upgrade. 16-bit DOS inputs are passed through and rejected by angr, which has no 16-bit lifter.

This adapter provides function and string inventory and search, function lookup, assembly, pseudocode, callers, callees, data xrefs, instruction windows, function dossiers, knowledge-base edits, and the decompilation flavor. Observed facts have these boundaries:

- Function bodies come from angr's recovered basic blocks and are reported as merged inclusive ranges.
- Callers and callees come from angr's call graph, fetched once per session. Unresolved indirect calls are absent, so relationship coverage is reported as partial. An edge whose endpoint angr lists no function for is omitted and named in the coverage limitations rather than failing the query.
- `xrefs` returns the instruction addresses of data references recorded during CFG recovery. Call and jump references are not included; use `procedure_callers`.
- Regex searches over the function and string inventories run in a cancellable worker thread with a five-second deadline, using ECMAScript Unicode syntax; a pathological pattern fails with a resource-constraint error and leaves the session usable.
- Pseudocode is angr's decompiler output. Functions above angr's complexity limits fail with the upstream reason; a function dossier retains assembly and relationships and reports the missing pseudocode as a limitation.
- Signatures are angr's recovered prototypes when present. Locals, comments, typed reference flags, referenced strings and names, and basic-block successors are not reported.
- Symbolic execution and emulation are not exposed.

## Knowledge-base edits

angr's edit tools are exposed as session-scoped edits of its knowledge base. Original executable bytes are never written, and nothing persists after `close_binary`.

- `set_address_name` and `set_addresses_names`: a function entry renames the function; any other mapped address names a global. Readback is the per-address boolean the shared contract defines.
- `set_comment`: writes angr's comment at an instruction address. angr keeps one comment store that it mirrors next to the matching pseudocode statement; a comment at a non-statement address is snapped down to the nearest statement boundary. `set_inline_comment` is unsupported because angr has no separate inline store.
- `annotate_native_function`: renames the function and sets its entry comment, then returns a refreshed dossier. `inline_comment` is rejected for this provider. When the comment is not changed, the readback reports `null` because angr's MCP server has no comment read.
- `rename_native_variables`, `set_native_variable_types`, `set_native_function_prototypes`: batch edits mapped to angr's `rename` and `set_type` tools. Each item reports its own outcome; a failed item does not discard its siblings, and applied items are not rolled back, so use `dry_run` as a pre-flight. Retyping an argument rewrites the prototype and re-decompiles the function; a prototype change discards the cached decompilation, and angr restores earlier renames and manual types afterwards.

Edits invalidate REA's immutable analysis snapshots and the session's cached call graph, so later callers, callees, and dossiers reflect the new names.

## Decompilation flavor

angr renders pseudocode in a session-wide flavor: `pseudocode` (C-like, the default), `rust`, or `go`. Caches, prototypes, and edits are kept per flavor. `inspect_native_decompilation_flavor` reports the current flavor, the available flavors, and angr's source-language detection as a hint; `set_native_decompilation_flavor` changes it for later `procedure_pseudo_code` and `analyze_function` calls and is recorded in each result's raw Evidence. The `flavor` registration key applies a default after the project loads.

These operations need an angr whose MCP server advertises `get_decompilation_flavor` and `set_decompilation_flavor`. On an older angr they fail with a capability-unavailable error, and a configured `flavor` key fails the session at startup with that reason.

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
