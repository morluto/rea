# Leandec provider

[Leandec](https://github.com/bovel84/Leandec) is a macOS/Linux Ghidra workbench with a
persistent SQLite cache and its own MCP server. This provider makes REA a client of that
server: REA keeps its Evidence, profiles, lifecycle and tool contracts, while Leandec keeps
the Ghidra project, the analysis cache and the project lock.

No Hopper installation is involved. Leandec is not bundled, downloaded or modified by REA.

## Configure

```bash
export LEANDEC_MCP_SERVER=/absolute/path/to/leandec/mcp_server.py
export REA_ANALYSIS_PROVIDER=leandec          # select it explicitly
export LEANDEC_PYTHON=python3                 # optional, default python3
rea doctor --provider leandec
```

Select it with `--provider leandec`, MCP's `open_binary.provider_id: "leandec"`, or
`REA_ANALYSIS_PROVIDER=leandec`. With another usable deep provider for the same target,
`auto` reports `ambiguous` instead of choosing one; selection never falls back after a failed
request.

| Setting                     | Default         | Meaning                                                                                               |
| --------------------------- | --------------- | ----------------------------------------------------------------------------------------------------- |
| `LEANDEC_MCP_SERVER`        | none (required) | Absolute path of Leandec's `mcp_server.py`. Without it the provider is reported `not_configured`.     |
| `LEANDEC_PYTHON`            | `python3`       | Interpreter that starts the MCP server. An absolute path must be executable.                          |
| `LEANDEC_CALL_TIMEOUT_MS`   | 120000          | Deadline for one MCP tool call.                                                                       |
| `LEANDEC_IMPORT_TIMEOUT_MS` | 3600000         | Deadline for an automatic first import, polled through Leandec's `job` tool.                          |
| `LEANDEC_INVENTORY_LIMIT`   | 50000           | Cap on the function rows REA loads for inventory and search.                                          |
| `LEANDEC_STRING_LIMIT`      | 20000           | Cap on the string rows REA loads for listing and search.                                              |
| `LEANDEC_AUTO_ANALYZE`      | `1`             | Import an unknown target in Leandec's background job. Set to `0` to require a prior `lean.py import`. |

Leandec owns the Ghidra heap and worker limits (`LEANDEC_MAXMEM`, `LEANDEC_CPUS`) because it
starts the analysis process itself.

The doctor check inspects configuration and the interpreter without launching Ghidra. For a real-provider smoke check, open a known ELF or Mach-O fixture with MCP `open_binary` and `provider_id: leandec`, then run `list_procedures`, `search_strings`, `procedure_pseudo_code`, `read_bytes`, and `close_binary`. Confirm the returned Evidence digest matches the selected file, and reopen the same fixture to confirm cache reuse. This smoke check requires a working local Leandec/Ghidra installation.

## What Leandec answers

| Tool                                                        | Leandec source                                                       |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| `list_documents`                                            | The selected target path                                             |
| `list_procedures`, `search_procedures`, `procedure_address` | SQLite function inventory with Ghidra namespace and entry addresses  |
| `address_name`                                              | Function entries, then Leandec's local labels                        |
| `procedure_pseudo_code`                                     | Cached Ghidra pseudocode; decompiled on demand when missing          |
| `procedure_assembly`                                        | Cached Ghidra listing; disassembled on demand when missing           |
| `procedure_callers`, `procedure_callees`                    | Leandec's cached function reference index                            |
| `xrefs`                                                     | Exact-address incoming instruction references from the cached index  |
| `list_strings`, `search_strings`                            | Strings captured at import time                                      |
| `read_bytes`                                                | Original slice bytes with stored overlay patches marked, not applied |

Typed references, comments, bookmarks, analysis mutation, CFG blocks, `analyze_function`,
`batch_decompile` and raw instruction windows are not exposed by this adapter. Use another
provider, or Leandec's MCP server directly, for those operations.

## Cache reuse

- Answers are keyed by the target's SHA-256 and Leandec's own analysis profile; REA's
  profile parameters record the target digest, format, architecture and inventory/string caps.
- A target already present in Leandec's registry is read from SQLite with no Ghidra start.
  `decompile`, `disassemble`, `cfg` and `xrefs` only start Ghidra for functions that are not
  cached yet.
- A different path whose bytes match an existing target reuses that target's key: Leandec's
  import is idempotent for identical content, records the new path as an alias and never
  re-imports into the existing project.
- Automatic imports copy the selected verified bytes to the private, content-addressed `rea-inputs` directory inside `LEANDEC_HOME` (or Leandec's default cache). Those copies are durable because Leandec's registry refers to them. They are not removed on session close; remove them only with their corresponding Leandec projects. Temporary staging is removed separately.
- REA declares `cachePolicy: "live"`: Leandec's cache is the durable boundary, so REA does
  not replay its own snapshot and always reflects newly cached text.

## Limitations

- Mach-O (thin or one selected universal slice) and ELF executables only. PE, DOS, raw
  binaries, archives and analysis databases are rejected with a typed reason.
- Windows is not supported by this adapter.
- Pseudocode and assembly are Ghidra reconstructions. Function names, local variables and
  varargs argument order can be wrong; verify with assembly before relying on them.
- String coverage is the import-time inventory. Packed or undefined literals can be absent.
- Reference coverage is the cached index for analyzed functions; unresolved indirect calls
  and targets outside that inventory can be absent. An empty list is not proof of absence.
- `address_name` answers entry names and Leandec labels, not arbitrary interior symbols.

## Security

Leandec analyzes static files. The adapter launches only the configured Python interpreter and
`mcp_server.py`; it never executes the target and never writes to the analyzed file. Leandec's
MCP server also exposes mutating tools (`patch`, `rename`, `bookmark`); this adapter does not
call them, but the server process itself is not a sandbox. Analyze untrusted binaries in an
isolated environment and verify the license and rights before reconstruction.

Numeric limits must be decimal integers from 1 through 2147483647. Invalid launch values disable the provider instead of silently choosing defaults. Regex mode uses REA's accepted regex deadline and worker heap settings.
