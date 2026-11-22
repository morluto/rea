# IDA provider

REA adapts an existing IDA MCP server into its native analysis tools. Headless IDA Pro analysis uses the [mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp) database supervisor or the official [Hex-Rays IDA MCP](https://github.com/HexRaysSA/ida-mcp); analysis of a database already open in the IDA GUI uses the separate [ida-free-mcp native plugin](https://github.com/0xshlomil/ida-free-mcp) for IDA Pro and IDA Free. Install and configure your selected engine and upstream MCP using their instructions. REA does not install, upgrade, activate, or license them, and does not bundle another IDA server.

Choose one lifecycle mode in an upstream MCP JSON registration. An attached registration (the default mode) must also name its upstream protocol, `"protocol": "native"`. A headless database-supervisor registration omits `protocol`; the Hex-Rays profile sets `"protocol": "hexrays"`. An attached registration without `protocol` is refused with a configuration error naming the choice. A registration that still names `"protocol": "legacy"` is refused with guidance to [migrate it](#migrate-a-legacy-attached-registration): the ida-pro-mcp 1.4 attached protocol has been removed, and REA never reads that value as another protocol. Set `REA_IDA_MCP_CONFIG` to that file, then select `ida` once through `REA_ANALYSIS_PROVIDER`, the CLI's `--provider ida`, or MCP's `open_binary.provider_id`. No provider startup occurs during discovery.

## Supported upstream versions

Each mode accepts one upstream tool profile, checked against `tools/list` before any analysis runs. The attached profile requires the native plugin's tool catalog and its `ida://idb/metadata` resource. REA has not established an attached-mode lifecycle and ownership contract for the mrexodia 2.x GUI tool catalog, so an attached registration that reaches it fails closed with the missing tool names in the error diagnostics.

Startup failures identify the accepted REA analysis operation. Missing-profile and typed startup transport failures retain the original stage in `details.diagnostics.startup_operation`; existing diagnostics, timeout budgets and resource limits remain available. Startup remains shared within a session; each caller receives its own operation attribution. Cancellation retains live cleanup ownership, so a successful retry releases the originating cancellation outcome as well.

The headless profile is defined by the database-supervisor API, not by an upstream version string. The upstream source snapshot [`c133c385`](https://github.com/mrexodia/ida-pro-mcp/tree/c133c3853faa111a9b00ee615c013b720d0c4acd) includes `idb_close` (introduced by [upstream PR #495](https://github.com/mrexodia/ida-pro-mcp/pull/495)) alongside `idb_open` and `idb_list`. Earlier builds may report the same `2.0.0` version while lacking that tool, so REA checks the live catalog rather than treating a version number or branch name as a compatibility guarantee.

| Mode                               | Upstream profile    | Known working                                                                            |
| ---------------------------------- | ------------------- | ---------------------------------------------------------------------------------------- |
| attached (`"protocol": "native"`)  | ida-free-mcp plugin | see [the native bridge](#native-ida-mcp-bridge)                                          |
| headless                           | database supervisor | builds serving `idb_open`, `idb_list`, and `idb_close`                                   |
| headless (`"protocol": "hexrays"`) | Hex-Rays IDA MCP    | builds serving `open_database`, `list_databases`, `close_database`, and `execute_python` |

## Analyze an already-open GUI target

Attached analysis uses the [native IDA MCP bridge](#native-ida-mcp-bridge). Write its local endpoint to a JSON file with `"protocol": "native"`. An existing `mcpServers` object with an `ida-pro-mcp` entry is also accepted; add `"protocol": "native"` to that entry. For example:

```json
{
  "mode": "attached",
  "protocol": "native",
  "url": "http://127.0.0.1:13337/mcp"
}
```

```bash
export REA_IDA_MCP_CONFIG=/absolute/path/to/ida-mcp.json
export REA_ANALYSIS_PROVIDER=ida
rea function /absolute/path/to/program main --json
rea decompile /absolute/path/to/program main --json
```

If the registration cannot be read or validated, provider diagnostics retain its
selected `registration_path` and the configuration owner's setting/constraint
facts in `configuration_details.settings`. The availability's `remediation`, and
each operation it makes unavailable, carry the configuration owner's repair.
`configured` means a path was selected, not that it is valid or an IDA connection
was established; failed registrations remain unavailable. Correct
`REA_IDA_MCP_CONFIG` in the next CLI invocation's environment or the MCP server's
launch environment. Restart/reconnect that server after changing its environment;
an export in another shell does not update a running server.

In attached mode, open the **original input binary** in REA, not an `.idb` or `.i64` database. Its SHA-256 must match IDA's recorded input hash.
REA checks the attached identity and image base around each analysis request. A mismatch or target switch fails with recovery guidance.
The original input must remain readable by REA; WSL can use its mounted alias while the GUI runs on Windows.
Attached profiles, including native mode, refuse universal Mach-O inputs at admission: every slice shares the recorded whole-file hash, so REA cannot verify which slice the GUI loaded.
Open a thin file extracted with `lipo -thin` in both IDA and REA, or use headless mode, which analyzes the selected slice.
An HTTP registration's `url` must use `http` or `https` without URL credentials,
and its host must be `localhost`, `127.0.0.1`, `[::1]`, or the Docker/Podman
host-gateway name `host.docker.internal` or `host.containers.internal`. Use a
gateway name when REA runs in a container and IDA MCP listens on the container
host. REA refuses every other host.

Open the **original input binary** in REA, not an `.idb` or `.i64` database. Its SHA-256 must match IDA's recorded input hash. REA checks the attached identity and image base around each analysis request. A mismatch or target switch fails with recovery guidance. The original input must remain readable by REA; WSL can use its mounted alias while the GUI runs on Windows. Attached profiles, including native mode, refuse universal Mach-O inputs at admission: every slice shares the recorded whole-file hash, so REA cannot verify which slice the GUI loaded. Open a thin file extracted with `lipo -thin` in both IDA and REA, or use headless mode, which analyzes the selected slice.

REA's close operation releases its MCP connection or proxy. It never saves or closes the existing GUI database. External edits remain visible because results are live and are not replayed from snapshots. These checks do not lock the GUI or prove that the database is unpatched.

## Native IDA MCP bridge

IDA Pro and IDA Free use the separate [ida-free-mcp native plugin](https://github.com/0xshlomil/ida-free-mcp) through an explicit attached registration. Install and start that plugin using its upstream instructions, open the original binary in the IDA GUI, and wait for analysis. The native MCP 1.1.2 release binds `0.0.0.0` without a listen-address setting. Restrict inbound access with the host firewall or use an upstream build that binds only to loopback before starting it. REA's local URL restriction does not change the plugin's listener. REA does not install IDA, build the plugin, activate a license, or launch the GUI.

Set `REA_IDA_MCP_CONFIG` to the [attached registration](#analyze-an-already-open-gui-target) and select `ida` using the same CLI/MCP commands. Native mode requires `resources/read` for `ida://idb/metadata` and its recorded input SHA-256; it never substitutes a digest of an unrelated local file. The native resource's `path` describes the IDB in the upstream protocol, not the original input path. REA retains it and checks database identity and image base before and after requests.

This experimental profile provides function/string inventory and search, function lookup, assembly, GUI pseudocode, callees, address xrefs, instruction windows, and function dossiers. Direct callers remain unavailable: native code/data xref labels do not prove call edges. It requires neither IDAPython nor idalib. Native headless registrations are rejected.

Native string observations use upstream C-string rendering; other representations remain unknown. Literal searches request conservative candidates and apply REA's original case and Unicode matching rules. Regex searches retain the full scan because native byte-oriented regex semantics cannot replace REA's Unicode regex semantics. All candidate pages are examined, and upstream search errors remain failures.

Native callee resolution batches unique queries and checks each reply's query identity. Results remain live: a recorded input hash does not establish database revision, so cross-request analysis caches cannot prove freshness. For focused questions, use pseudocode, callees, or instruction-window tools; a function dossier requests additional facets and returns more Evidence.

IDA Free's cloud decompiler needs network access and may request consent. Follow its licensing and supported architecture limits; see [IDA Free](https://hex-rays.com/ida-free). Decompilation moves GUI focus and the upstream plugin closes existing pseudocode tabs before requesting fresh output. REA advertises UI/network effects and closes only its MCP connection, preserving the open database. Rendered pseudocode has upstream traversal limits and does not prove complete source recovery. Cloud/widget failures remain explicit failures; retry after the GUI finishes or dismiss its prompt.

Native MCP 1.1.2 can navigate in the previously focused pseudocode tab when switching functions. Use upstream 1.1.3 or a source build including [the navigation correction](https://github.com/0xshlomil/ida-free-mcp/commit/6adf2c615a2a03661059673e9c136ef28d0dc778), which focuses the disassembly view **before** jumping to the requested entry. This REA profile does not repair stale GUI output. Verification must include two different functions before claiming reliable function switching. The initial Linux verification used a locally corrected 1.1.2 plugin; upstream 1.1.3 has not been verified by that run.

Native tool observations retain actual tool names and complete JSON text. Upstream `structuredContent` can be a shortened preview even while text contains the full result. REA reads the full native representation and rejects missing/malformed text instead of treating previews as complete observations.

### Migrate a legacy attached registration

REA no longer supports the ida-pro-mcp 1.4 attached GUI proxy. A registration
that names `"protocol": "legacy"` is refused at configuration with a
`REA_IDA_MCP_CONFIG` constraint naming this section; REA never connects to the
proxy or reads the value as another protocol, and it does not rewrite the file.
Replace the registration yourself with one of the supported profiles:

- the native plugin below, to keep analyzing the database already open in the
  IDA GUI; or
- an ida-pro-mcp 2.x database supervisor in
  [headless mode](#give-rea-a-target-for-headless-analysis), where REA opens and
  closes its own private copy of the input instead of the GUI database.

Migrating to the native plugin replaces the upstream server; changing
`"protocol"` to `"native"` in a legacy Python proxy registration is insufficient.
The native plugin is separate from mrexodia/ida-pro-mcp, and upgrading mrexodia to
its modern tool catalog does not select this profile.

1. Back up the working registration file. Install and start the native plugin
   using its [upstream instructions](https://github.com/0xshlomil/ida-free-mcp).
   IDA and the plugin are bring-your-own; REA does not install or build them.
   Use a build with the navigation correction described above, and restrict its
   listener to loopback or apply the documented host firewall restriction.
   Stop the legacy endpoint first if both servers would use the same port.
2. Open the same original input binary in IDA and wait for analysis. Keep that
   file readable by REA. The native metadata resource must report its recorded
   input SHA-256; the resource's `path` identifies the database, not an input
   file to substitute. Universal Mach-O inputs still require a thin extraction.
3. Replace the registration, using the native plugin's actual local endpoint.
   For example, this legacy registration:

   ```json
   {
     "mode": "attached",
     "protocol": "legacy",
     "command": "python",
     "args": [
       "/absolute/path/to/ida_pro_mcp/server.py",
       "--ida-rpc",
       "http://127.0.0.1:13337"
     ]
   }
   ```

   becomes (REA refuses the first form):

   ```json
   {
     "mode": "attached",
     "protocol": "native",
     "url": "http://127.0.0.1:13337/mcp"
   }
   ```

   Keep `REA_IDA_MCP_CONFIG` pointing at the replacement file and close/reopen
   the REA binary session to connect with it. If changing the environment's
   configuration path, restart the MCP server as described above. Do not reuse
   the legacy RPC URL as an MCP HTTP endpoint.

4. Check `binary_session` availability before resuming workflows. Direct
   `procedure_callers` becomes unavailable and dossier callers remain unknown;
   incoming address xrefs do not establish direct call edges. Native strings
   use C-string rendering. Assembly and instruction reads no longer navigate
   the GUI; native pseudocode still changes focus and closes existing
   pseudocode tabs. IDA Free decompilation may require cloud access and consent.
5. Run the [real-provider verification](#verification) with two distinct
   functions and the required second-function marker. Supply independently
   known string and xref oracles for those checks. Existing Windows evidence
   covers IDA Pro 9.3 with the documented source build and listener change;
   it does not establish stock-plugin, Windows Free, or native macOS behavior.
   A valid registration or successful doctor check alone does not verify the
   connection, target identity, or function switching.

REA continues to verify identity and image base around requests and closes only
its connection, preserving the attached database. The removed legacy profile was
the only one that reported direct `procedure_callers`; no supported profile
replaces it, so caller questions remain unknown rather than inferred from xrefs.

Native GUI decompilation changes the active view as a side effect. `binary_session` reports pseudocode and function dossiers with `effects.may_show_ui: true`; assembly, raw function instructions, the other attached operations, and headless operations report `false`.

## Give REA a target for headless analysis

The headless profile supports upstream's **database supervisor** API: `idb_open`, `idb_list`, `idb_close`, explicit `database` arguments, and modern analysis tools. Legacy 1.4.0 `idalib-mcp`, which accepts one initial filename and serves SSE, does not implement this profile. Follow the [upstream headless instructions](https://github.com/mrexodia/ida-pro-mcp#headless-idalib-session-model) for an installation with the supervisor API.

```json
{
  "command": "idalib-mcp",
  "args": ["--stdio", "--max-workers", "1"],
  "mode": "headless"
}
```

Use an already-installed executable. When required by your existing idalib installation, include `"env": { "IDADIR": "/absolute/path/to/ida" }`. REA neither edits the global activation configuration nor installs dependencies. A configured local Streamable HTTP supervisor can instead use `"url": "http://127.0.0.1:8745/mcp"` and `"mode": "headless"`.

The same CLI commands work in both modes. For a Windows-native REA process:

```powershell
$env:REA_IDA_MCP_CONFIG = 'D:\analysis\ida-mcp.json'
$env:REA_ANALYSIS_PROVIDER = 'ida'
rea function 'D:\samples\program.exe' main --json
```

Headless REA and the configured supervisor must share the host filesystem and native path syntax. Run REA on Windows when the supervisor runs on Windows. The attached profile can span WSL and a Windows GUI because it binds recorded input hashes instead of asking the GUI to open a WSL path.

REA copies the admitted binary into a private temporary directory, checks its digest, and requests an owned worker with `force_headless`. POSIX workspaces are created atomically with owner-only permissions, respecting the process umask; Windows uses the matching package's native private-DACL boundary on a local NTFS/ReFS temporary directory. It injects the returned database ID into analysis requests. It verifies the active owned worker and input path rather than adopting a user database. On a successful close, or a failed startup that never reached completed auto-analysis, it releases its session with `save: false`, verifies that it is absent from upstream session discovery, and removes its private input and sidecars. An unverified release retains the workspace and reports incomplete cleanup. If auto-analysis has already completed (`auto_analysis_ready=true`) and a later tool call fails, REA instead closes the database-supervisor session with `save: true`, keeps the private workspace, and reports that location in the failure's `retained_database` diagnostic (`workspace`, and `idb_path` when health reported one). A later health read that times out, is malformed, or no longer verifies the selected target still retains the workspace but closes unsaved (`retained_database.save: "not_requested"`). The Hex-Rays profile has no save argument on `close_database`; after a successful retained close, `retained_database.save` is `"unknown"` because REA never requests a save and the saved state is unconfirmed. This is intentional retention of a completed analysis database, not incomplete cleanup. If a saved close releases the worker but its reply is lost, a later close treats the recognized absent-session response as a verified release, keeps the workspace, and reports `retained_database.save: "unknown"` instead of blocking cleanup. On Windows, retaining the workspace releases the private-runtime handles and owner registration without deleting the directory. The directory is still under the temporary workspace parent (`tmpdir` or `workspaceRoot`); copy the retained `.i64` and sidecars elsewhere if you need them beyond that directory's lifetime. REA's CLI `--snapshot` records analysis evidence only when the call itself succeeds and does not keep this IDA database.

One REA session owns one database. Stdio registrations default `IDA_MCP_MAX_WORKERS` to `1`; the explicit upstream `--max-workers 1` also bounds a supervisor. Database size and engine memory depend on the target and upstream; REA does not impose an engine memory limit. The original binary is never executed or overwritten. Optional `workspaceRoot` selects an existing absolute temporary-directory parent on the REA host. The selected parent is resolved by the filesystem before deriving its canonical identity, including POSIX symlink/parent components. Ensure it has space for the input copy and IDA working files.

Readiness and allocation check the selected spelling with native
[`stat`](https://github.com/nodejs/node/blob/v24.22.1/doc/api/fs.md#fspromisesstatpath-options)
before canonicalizing it. This retains missing and non-directory intermediate
lookup failures: [macOS `realpath`](https://github.com/apple-oss-distributions/Libc/blob/71bbe350ab79eef58113991d817ccc6165061a64/stdlib/FreeBSD/realpath.c)
alone can collapse `file/..`. Diagnostics retain the selected spelling; private
input paths use the canonical parent for upstream identity checks.

When a completed `idb_open` response reports success or is otherwise ambiguous, but no active owned private worker can be verified, REA retains the private workspace even if `idb_list` appears empty. A later close can retry verification if the original owned worker becomes discoverable. A completed explicit `idb_open` rejection retains the existing no-worker cleanup path. This is a local admission/ownership safeguard and **does not** provide a process-termination receipt or change the legacy reaped-worker protocol.

Headless cleanup uses the upstream database lifecycle. Abruptly terminating REA, its proxy, or the supervisor does not establish worker release. Prefer `close_binary` for MCP sessions; after an interrupted process, inspect upstream session inventory and retained workspace diagnostics before removing working files. This adapter does not claim Windows Job Object containment for the upstream detached workers.

## Use the official Hex-Rays IDA MCP

The `hexrays` protocol drives the [Hex-Rays IDA MCP](https://github.com/HexRaysSA/ida-mcp) headlessly. Upstream requires IDA 9.4 or later with idalib and Python 3.11 or later, with `uv` and Git on `PATH`; REA installs none of them. Register the server for stdio:

```json
{
  "command": "ida-mcp",
  "args": ["stdio", "--agent=rea"],
  "mode": "headless",
  "protocol": "hexrays"
}
```

The profile is headless and stdio only. Hex-Rays database leases belong to the MCP server process, so REA's own stdio child is what makes a lease provably REA's. Attached and HTTP Hex-Rays registrations are rejected, and analyzing a database already open in the IDA GUI is not supported. A registration that omits `protocol` but reaches a Hex-Rays server fails at startup with `advertised_tools` and a recovery naming the `hexrays` registration.

Use the stdio launch command and arguments from your existing installation. This profile accepts the `idalib` and `idat` headless backends. With the official plugin installed, [Hex-Rays can select `idat`](https://github.com/HexRaysSA/ida-mcp#manual-installation), which uses IDA's Python and installed plugins. To use `idalib` even with the plugin installed, add `"env": { "IDA_NEXUS_IDALIB_ONLY": "1" }` to the registration. The upstream `uvx --exclude-newer=1s` example can resolve newer releases than the version listed in [verification coverage](#verification).

REA copies and verifies the input in a private workspace as for the database supervisor, then calls `open_database` on that copy with `set_current: false`. Hex-Rays assigns the instance ID. REA checks that the open reply and inventory agree on the lease and headless backend, and that the inventory path binds it to the private input. Analysis Evidence records the bound backend as `raw_result.worker_backend`. An `idat` worker must also report its database path inside the private workspace. A GUI database is refused, and the open is treated as unverified.

### Start from an existing IDA database

The `hexrays` profile also opens an existing `.idb` or `.i64`, so analysis starts from its saved names, types and comments instead of a fresh auto-analysis. Pass the database itself to `open_binary` with `provider_id: "ida"`. REA identifies packed IDA databases by their `IDA1` or `IDA2` signature. The upstream loader also requires the corresponding `.idb` or `.i64` filename suffix. REA copies the whole file into the private workspace before opening it. The copy matters: idalib repacks a database when its last lease is released, even without a save, so opening the selected file directly would rewrite it. The selected database is only read.

For an executable, REA checks the private input path and file digest. When IDA reports a recorded input hash, REA compares it with the admitted copy, including the selected thin slice for a universal Mach-O. For a saved database, REA binds the opened copy by `idb_path`. Its `input_path` and `input_sha256` describe the original executable. Results reflect the database's saved content: unsaved changes held by another IDA session, including an unpacked `.id0`/`.id1` set beside it, are not included. Evidence subjects identify the database file, not the input binary. Attached and database-supervisor registrations reject database targets, and Hopper rejects IDA databases.

Hex-Rays MCP exposes database reads only through `execute_python`. REA loads a fixed, read-only query module once per database lease, [`bridge/ida/hexrays_queries.py`](https://github.com/morluto/rea/blob/main/bridge/ida/hexrays_queries.py), and invokes `_rea_query(name, arguments_json)` for each read. If the worker no longer defines that entry point, REA reloads the module and retries the read once. The module answers the same database-supervisor reads REA already validates: health, function inventory and lookup, strings, paged pseudocode and assembly, callees, a depth-zero call graph, xrefs to an address, and a minimal segment survey. Caller-supplied text only ever reaches the module as JSON data, never as Python source, and REA forwards no other Python. Each observation records `execute_python` as the upstream tool, plus the query name, its arguments, and the module's SHA-256 instead of its body. The health reads behind each operation's identity checks are kept the same way, as `health_observations` beside the parsed metadata. Call scans skip data items inside functions.

`execute_python` waits for initial auto-analysis, so readiness is checked before the first read. Function sizes are enclosing spans, as with other IDA profiles. Strings come from IDA's default string list. Xrefs exclude ordinary flow from the preceding instruction. Callees on x86-only targets report every direct code or pointer target of a call instruction: targets inside a function are internal and resolve to that function, and imports, pointer slots, and code outside every function are reported by address as external. Indirect calls without a reference remain unknown. Other targets use the processor-neutral call graph, which reports function entries reached by IDA’s near or far call references. Direct callers remain unavailable for the same reason as in the database-supervisor profile. The observed Hex-Rays MCP does not truncate or preview `execute_python` results, and REA requests up to 1,000 entries per function or string page and up to 1,000 lines or instructions per pseudocode or disassembly page. Nonempty engine stdout and stderr are retained in the observation.

On close, REA releases its lease with `close_database`. Before removing the workspace, it checks `list_databases` for its lease ID and for any database path inside the workspace. An unleased row can represent a peer or a worker still shutting down. Nexus keeps an `idat` worker's lifetime lock through process exit. Hex-Rays can flush and repack the private database during analysis and release. These database writes stay in the private workspace.

An error or missing reply from `open_database` leaves startup unverified. For example, Nexus can return a startup timeout while the worker is still starting. An empty inventory does not establish that the worker stopped. On cleanup retry, REA can release an owned lease it finds for the private input. If startup remains unverified, REA keeps the workspace for manual recovery after the upstream worker has stopped. A GUI database is never released or closed. The Hex-Rays MCP also writes per-session JSONL traces of its tool calls under `~/.idapro/mcp/sessions/`.

## Connect an agent once

Add the registration path to the **REA** MCP entry's environment, keeping the upstream registration in its separate JSON file:

```json
{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ["-y", "rea-agents@<version-with-ida>", "mcp"],
      "env": {
        "REA_ANALYSIS_PROVIDER": "ida",
        "REA_IDA_MCP_CONFIG": "/absolute/path/to/ida-mcp.json"
      }
    }
  }
}
```

Use a package version that actually includes this adapter; repository main can be ahead of the npm release. After reconnecting, call the sequence below; the default `analyze_function` reply is a summary that retains the dossier, so add `"detail":"complete"` when the dossier itself must come back inline:

```json
{"name":"open_binary","arguments":{"path":"/absolute/path/to/program","provider_id":"ida"}}
{"name":"analyze_function","arguments":{"procedure":"main"}}
{"name":"search_strings","arguments":{"pattern":"license"}}
{"name":"close_binary","arguments":{}}
```

Opening an MCP target starts its selected provider session; headless opening waits for auto-analysis. Set the agent's MCP request deadline long enough for the target. The registration JSON named by `REA_IDA_MCP_CONFIG` has an optional `timeoutMs` integer from 1 to 2147483647. Omitted means 300000. REA applies an edited value on the next IDA connection after it re-reads that file; an already open session keeps the timeout it connected with. Changing the `REA_IDA_MCP_CONFIG` path itself is read at process start. An upstream SDK request that reaches this limit returns `provider_timeout` naming the effective milliseconds and `timeoutMs`. A shorter inner request is the time remaining inside that ceiling, and the error names both when they differ. A freshly opened headless worker can briefly report `status: "busy"` from `server_health`; REA re-reads health every 100 ms until the worker answers, the caller cancels, or `timeoutMs` has elapsed since the first read. Each health request is capped by the time remaining in that overall wait, so a stalled read cannot extend the readiness deadline by another full request timeout. Expiry while the worker is still busy produces a retryable `provider_timeout`; no further read is started after the deadline. That error names the busy tool from the last observation, or `unknown` when the worker reported none or a value that is not tool-name-shaped. If a health request itself consumes the remaining wait budget, the same last-busy timeout is returned with the stalled request's captured output. Cancellation during the wait produces `cancelled`. Any other unexpected health payload, including a busy payload with an invalid shape, remains `unreadable_output`. Cancellation drains the current upstream request before cleanup; it does not force-stop GUI analysis. An open request that times out without a completed response retains the private workspace because worker inventory alone cannot prove the request has stopped. `binary_session` reports actual tool availability. Repeated doctor/setup calls are unnecessary when the registration already works.

A long headless analysis also passes through the database supervisor's own deadlines, which REA's `timeoutMs` does not change. In the documented ida-pro-mcp snapshot `c133c385`, the supervisor reaps a worker still opening and auto-analyzing after `IDA_MCP_OPEN_TIMEOUT` seconds (default 1800). REA reports that rejection as `provider_timeout` naming the setting. The supervisor also treats a live but silent worker as wedged after `IDA_MCP_WEDGED_GRACE_SEC` (default 1800), and bounds each forwarded tool call by `IDA_MCP_WORKER_CALL_TIMEOUT` (default 900); `0` disables each. They are environment variables of the process that runs the supervisor and apply when it starts. For a large binary whose auto-analysis takes longer, raise every deadline layer together: the agent's MCP request deadline, the registration `timeoutMs`, and those supervisor settings. A transport-truncated later tool result still fails closed (`IDA MCP truncated its output; the preview cannot establish a complete observation`) and is not turned into a partial or successful observation. After such a failure, use the `retained_database` path on the error to recover the saved database instead of re-analyzing from scratch.

For guided registration, set `REA_IDA_MCP_CONFIG` before `rea setup --client <client>`. Setup includes that file reference in its reviewed plan and preserves it after approval; it does not copy upstream credentials into the agent configuration. For `ida` or `auto` selection, Codex/Kimi setup and doctor use the effective client registration's parsed `timeoutMs` (default 300000 ms) when recommending the agent's per-tool deadline. Existing positive client deadlines remain caller choices. `rea doctor --provider ida --json` validates the registration without starting IDA and explicitly leaves runtime compatibility and target binding for analysis.

## Coverage and evidence

REA admits x86, x86_64, arm and arm64 executables through IDA. Every other CPU
family, including families that REA recognizes later, is refused until REA
admits it explicitly. Raw-binary and GameCube DOL targets are refused; open
them with Ghidra. Admission is not verification: the real workflows under
[Verification](#verification) cover x86_64 and arm64 only.

All profiles support procedure/string inventory and literal or regex search, procedure resolution, pseudocode, assembly, raw function instructions, resolved callees, incoming address references, and a function dossier. Inventories and modern pseudocode/assembly follow upstream pagination. Upstream limits on modern xrefs and callees are retained as explicit truncation limitations. In the modern headless profile, targets that are not proven x86-only use processor-neutral `callgraph` edges instead of the x86 instruction checks in upstream `callees` (mrexodia/ida-pro-mcp#549). REA requests depth zero: the pinned upstream emits the root's outgoing edges without scanning child functions, then REA batches function-name lookup for those addresses. The graph covers recognized function destinations only; imports and other non-function targets remain unknown. A server without `callgraph` returns an empty relationship list with an explicit coverage limitation. Neither `callees` nor `callgraph` reports the call sites behind its edges, so a computed call's targets are never established as exhaustive; callee coverage is therefore `partial` even for an uncapped reply, and a call path that does not reach its goal remains `unknown`. Graph and path workflows retain those limitations alongside observed edges. A failed or inconsistent graph reply remains an error. A transport-level truncated preview is rejected rather than reported as complete evidence; the error preserves upstream retrieval guidance.

All profiles expose `list_documents` as the single target admitted for the session. Attached mode verifies its digest against IDA metadata before returning it; headless mode binds the digest-checked private input. `inspect_address_context`, `trace_feature`, and `binary_overview` can therefore resolve that identity without upstream document-listing tools. Segment enumeration is optional: when the selected profile cannot provide it, `binary_overview` still returns document and procedure/string counts and omits `segments` and `segment_count`; omission means unobserved, not empty. The modern headless profile also supports `resolve_containing_procedure`. An address resolves through upstream `lookup_funcs` to the canonical entry of the function that contains it; the body stays unavailable like other IDA identities. When no function contains it, REA reads the database-scoped minimal `survey_binary` and reports `not_in_procedure` for an address inside one of its segments (ends are exclusive) and `outside_segments` otherwise. A missing, truncated or inconsistent survey fails the read instead of guessing a reason. `trace_feature` marks a trace truncated, with a residual unknown for that address, when upstream caps the references it returned. Attached profiles do not declare address containment resolution.

No profile supports direct callers. Upstream code/data xref labels do not prove call edges, so `procedure_callers` is unavailable and the dossier marks callers unknown.

Complete body ranges, typed reference edges, CFG, referenced data, source locals, comment kinds, and database revision are unavailable. Empty unsupported dossier facets mean **unknown**, not observed absence. Whole-symbol inventory, mutation, debugging, arbitrary Python forwarding, and requested GUI navigation are outside this adapter's coverage; the Hex-Rays profile sends only its fixed query module. Check session availability before composing a workflow that needs those facets.

`provider.version` identifies the REA adapter; the profile explicitly records `version_scope: "rea-ida-adapter"`. The MCP handshake's `serverInfo` is separate and does not establish IDA or Python distribution versions. Raw observations preserve producer metadata and output. Attached hashes identify the recorded original input; headless identity uses the digest-verified private copy and observed worker input path. Neither proves source-code recovery or an unmodified analysis database.

## Verification

Run `npm run verify:ida -- --target /absolute/path/to/program --procedure main` with a configured upstream server. It exercises production CLI and MCP tools, validates their output contracts and Evidence, checks original-input preservation and session cleanup, and keeps local target data out of its console summary. Supply `--package-root` to verify an extracted or installed package. See [testing](../development/testing.md) for the distinction between adapter tests and real-provider evidence.

For the Hex-Rays profile, pass `--expected-backend idat` or `--expected-backend idalib` to verify the backend that served the CLI and MCP reads. The verifier records the observed backends. Add `--verify-peer-cleanup` to open REA’s private copy from a second upstream connection, confirm REA retains the workspace while that peer holds a lease, and verify removal after the peer releases and REA retries close. For `idat` verification, use an IDA installation with the official plugin and record the MCP and Nexus versions in both Python environments. Full REA `idat` verification is tracked in [issue #12921](https://github.com/morluto/rea/issues/12921).

Native verification requires `--second-procedure other_function --second-marker unique_second_body_text`; these options remain optional for the other profiles. The marker must occur in the second function's pseudocode and be absent from the first; the verifier also checks that returning to the first restores its text.

The verifier requires the resolved procedure in both inventory and procedure search, then compares address, assembly, pseudocode, instruction windows and relationship results with the CLI/MCP dossier. Supply `--expected-string known_literal` to check a known positive string inventory/search result and `--expected-xref 0xSOURCE` to check a known reference source address. Choose those oracles independently from the operation under test. Without them, string and xref correctness are listed in `unverified`; valid output shapes alone do not establish those behaviors. Callee parity does not independently establish semantic completeness. Native callee successes must report an explicit truncation marker; missing markers remain protocol failures.

The initial real workflows used stdio registrations for the since-removed legacy Windows GUI profile and a Windows x64 headless supervisor with IDA 9.3. The headless workflow has also passed on macOS arm64 with IDA Professional 9.1 (build 9.1.250226) against the same upstream commit `c133c3853faa111a9b00ee615c013b720d0c4acd`, using a source-built arm64 Mach-O fixture; Mach-O C symbols carry a leading underscore, so the procedure name is `_rea_fixture_add`. Streamable HTTP is tested against a loopback MCP fixture with the pinned client SDK; a real IDA HTTP-supervisor workflow remains unverified. Linux headless engine operation, other IDA releases, architectures, and modern attached GUI tools require their corresponding real workflows before support is claimed.

The Hex-Rays profile has passed `npm run verify:ida` on Linux x64 against Hex-Rays IDA MCP 20261008.0.1 with idalib, using the public two-function fixture built as an x86-64 ELF, the same fixture with an added string literal for `--expected-string`, and a statically linked AArch64 ELF build that exercises the call-graph callee path. It has also passed with the x86-64 fixture's saved `.i64` as the target, holding a function renamed in that database; the selected database stayed byte-identical. These historical runs used an `idalib` worker. The exact Nexus version was not recorded. Full REA workflows on other hosts and with PE or Mach-O targets remain unverified.

Native Windows verification uses IDA Pro 9.3 with the public two-function fixture and Windows `whoami.exe`, using upstream `c9d15d98e8a143fc74f6e14037c48f63889b6d6c` with a loopback-listener change. It covers production CLI/MCP parity, distinct-function switching, identity and connection cleanup. See the [correctness and performance measurements](https://github.com/morluto/rea/blob/a2e2c29b59e8775b0e6aedb09a9eb16adf32646b/experiments/analysis-efficiency/ida-native-windows.md). This follow-up did not run Windows IDA Free or native macOS.

Headless readiness distinguishes an explicit `auto_analysis_ready: false` from
unknown readiness (`null`). The former returns a retryable capability refusal
with wait-and-retry guidance; the latter asks for upstream readiness inspection
without claiming that analysis is running. Neither is malformed protocol output.
An unusable `workspaceRoot` reports its directory constraint as a configuration
error before opening an IDA worker. Native JSON metadata resources accept omitted
media types and normal case/parameter variants of `application/json`; their
resource URI, JSON structure and recorded target identity remain checked.

The public profile's registration digest excludes HTTP authentication header
values (`Authorization`, `Proxy-Authorization`, and `Cookie`). Mark any other
credential fields explicitly with `"sensitive": { "headers": ["X-Api-Key"],
"env": ["PRIVATE_VALUE"] }` in the registration. Header names match without
case; environment names match exactly. These values are also redacted from IDA
diagnostics. Ordinary fields such as `IDADIR` and noncredential headers remain
part of analysis identity. Credential rotation does not change that public
identity; each newly resolved client factory still captures its own complete
transport registration and creates a fresh connection.

Caller cancellation is classified at the MCP request boundary using the installed
SDK's exact abort outcome. A later abort during error unwinding does not replace
an established provider failure. Cancellation retains the caller's original reason
and collected diagnostics; metadata timeouts name the requested analysis operation
while retaining the resource-read failure as their cause. This request cancellation
does not authorize saving or closing an attached GUI database.

Registration refusals retain schema-authored constraints, including the
native/attached lifecycle requirement, local credential-free endpoint requirement
and absolute workspace root. Configuration diagnostics omit registration values.
Target and private-worker identity refusals retain the failed check, its reason
and recovery guidance in the public error before any analysis replies exist.
These diagnostics do not relax identity admission or authorize closing an attached
GUI database.
