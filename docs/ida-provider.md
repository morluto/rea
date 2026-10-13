# IDA provider

REA adapts an existing IDA MCP server into its native analysis tools. Existing IDA Pro profiles use [mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp); an optional native bridge for IDA Pro and IDA Free is described below. Install and configure your selected engine and upstream MCP using their instructions. REA does not install, upgrade, activate, or license them, and does not bundle another IDA server.

Choose one lifecycle mode in an upstream MCP JSON registration. Set `REA_IDA_MCP_CONFIG` to that file, then select `ida` once through `REA_ANALYSIS_PROVIDER`, the CLI's `--provider ida`, or MCP's `open_binary.provider_id`. No provider startup occurs during discovery.

## Supported upstream versions

Each mode accepts one upstream tool profile, checked against `tools/list` before any analysis runs. Upstream's `main` branch has since moved to 2.0.0, which renamed the GUI tools and dropped `idb_close`, so it serves neither profile. Installing from that branch fails at startup with the missing tool names in the error diagnostics.

| Mode     | Upstream profile    | Known working                                          |
| -------- | ------------------- | ------------------------------------------------------ |
| attached | legacy GUI tools    | 1.4.0                                                  |
| headless | database supervisor | builds serving `idb_open`, `idb_list`, and `idb_close` |

## Analyze an already-open GUI target

The attached profile supports upstream **1.4.0 legacy tools**, including `get_metadata`, `list_functions`, and `decompile_function`. Copy the upstream registration's `command`, `args`, and optional `env` into a JSON file. An existing `mcpServers` object with an `ida-pro-mcp` entry is also accepted. For example:

```json
{
  "command": "python",
  "args": [
    "/absolute/path/to/ida_pro_mcp/server.py",
    "--ida-rpc",
    "http://127.0.0.1:13337"
  ]
}
```

Use the executable and arguments from your working upstream registration. The legacy GUI's `/mcp` endpoint is its internal RPC endpoint; connect REA through the upstream stdio proxy rather than treating that URL as Streamable HTTP.

```bash
export REA_IDA_MCP_CONFIG=/absolute/path/to/ida-mcp.json
export REA_ANALYSIS_PROVIDER=ida
rea function /absolute/path/to/program main --json
rea decompile /absolute/path/to/program main --json
```

Open the **original input binary** in REA, not an `.idb` or `.i64` database. Its SHA-256 must match IDA's recorded input hash. REA checks the attached identity and image base around each analysis request. A mismatch or target switch fails with recovery guidance. The original input must remain readable by REA; WSL can use its mounted alias while the GUI runs on Windows.

REA's close operation releases its MCP connection or proxy. It never saves or closes the existing GUI database. External edits remain visible because results are live and are not replayed from snapshots. These checks do not lock the GUI or prove that the database is unpatched.

## Optional native IDA MCP bridge

IDA Pro and IDA Free can use the separate [ida-free-mcp native plugin](https://github.com/0xshlomil/ida-free-mcp) through an explicit attached registration. Install and start that plugin using its upstream instructions, open the original binary in the IDA GUI, and wait for analysis. The native MCP 1.1.2 release binds `0.0.0.0` without a listen-address setting. Restrict inbound access with the host firewall or use an upstream build that binds only to loopback before starting it. REA's loopback URL restriction does not change the plugin's listener. REA does not install IDA, build the plugin, activate a license, or launch the GUI.

```json
{
  "mode": "attached",
  "protocol": "native",
  "url": "http://127.0.0.1:13337/mcp"
}
```

Set `REA_IDA_MCP_CONFIG` to this file and select `ida` using the same CLI/MCP commands above. Omitting `protocol` preserves existing IDA Pro registrations. Native mode requires `resources/read` for `ida://idb/metadata` and its recorded input SHA-256; it never substitutes a digest of an unrelated local file. The native resource's `path` describes the IDB in the upstream protocol, not the original input path. REA retains it and checks database identity and image base before and after requests.

This experimental profile provides function/string inventory and search, function lookup, assembly, GUI pseudocode, callees, address xrefs, instruction windows, and function dossiers. Direct callers remain unavailable: native code/data xref labels do not prove call edges. It requires neither IDAPython nor idalib. Native headless registrations are rejected.

Native string observations use upstream C-string rendering; other representations remain unknown. Literal searches request conservative candidates and apply REA's original case and Unicode matching rules. Regex searches retain the full scan because native byte-oriented regex semantics cannot replace REA's Unicode regex semantics. All candidate pages are examined, and upstream search errors remain failures.

Native callee resolution batches unique queries and checks each reply's query identity. Results remain live: a recorded input hash does not establish database revision, so cross-request analysis caches cannot prove freshness. For focused questions, use pseudocode, callees, or instruction-window tools; a function dossier requests additional facets and returns more Evidence.

IDA Free's cloud decompiler needs network access and may request consent. Follow its licensing and supported architecture limits; see [IDA Free](https://hex-rays.com/ida-free). Decompilation moves GUI focus and the upstream plugin closes existing pseudocode tabs before requesting fresh output. REA advertises UI/network effects and closes only its MCP connection, preserving the open database. Rendered pseudocode has upstream traversal limits and does not prove complete source recovery. Cloud/widget failures remain explicit failures; retry after the GUI finishes or dismiss its prompt.

Native MCP 1.1.2 can navigate in the previously focused pseudocode tab when switching functions. Use upstream 1.1.3 or a source build including [the navigation correction](https://github.com/0xshlomil/ida-free-mcp/commit/6adf2c615a2a03661059673e9c136ef28d0dc778), which focuses the disassembly view **before** jumping to the requested entry. This REA profile does not repair stale GUI output. Verification must include two different functions before claiming reliable function switching. The initial Linux verification used a locally corrected 1.1.2 plugin; upstream 1.1.3 has not been verified by that run.

Native tool observations retain actual tool names and complete JSON text. Upstream `structuredContent` can be a shortened preview even while text contains the full result. REA reads the full native representation and rejects missing/malformed text instead of treating previews as complete observations.

The legacy producer moves the active GUI as a side effect: assembly and raw function instructions jump to the function, and successful pseudocode opens or reuses a pseudocode view. A function dossier does both. Native GUI decompilation also changes the active view. `binary_session` reports these operations with `effects.may_show_ui: true`; headless operations and the other attached operations report `false`.

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

REA copies the admitted binary into a private temporary directory, checks its digest, and requests an owned worker with `force_headless`. POSIX workspaces are created atomically with owner-only permissions, respecting the process umask; Windows uses the matching package's native private-DACL boundary on a local NTFS temporary directory. It injects the returned database ID into analysis requests. It verifies the active owned worker and input path rather than adopting a user database. On close or failed startup, it releases its session with `save: false`, verifies that it is absent from upstream session discovery, and removes its private input and sidecars. An unverified release retains the workspace and reports incomplete cleanup.

One REA session owns one database. Stdio registrations default `IDA_MCP_MAX_WORKERS` to `1`; the explicit upstream `--max-workers 1` also bounds a supervisor. Database size and engine memory depend on the target and upstream; REA does not impose an engine memory limit. The original binary is never executed or overwritten. Optional `workspaceRoot` selects an existing absolute temporary-directory parent on the REA host. Ensure it has space for the input copy and IDA working files.

When a completed `idb_open` response reports success or is otherwise ambiguous, but no active owned private worker can be verified, REA retains the private workspace even if `idb_list` appears empty. A later close can retry verification if the original owned worker becomes discoverable. A completed explicit `idb_open` rejection retains the existing no-worker cleanup path. This is a local admission/ownership safeguard and **does not** provide a process-termination receipt or change the legacy reaped-worker protocol.

Headless cleanup uses the upstream database lifecycle. Abruptly terminating REA, its proxy, or the supervisor does not establish worker release. Prefer `close_binary` for MCP sessions; after an interrupted process, inspect upstream session inventory and retained workspace diagnostics before removing working files. This adapter does not claim Windows Job Object containment for the upstream detached workers.

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

Use a package version that actually includes this adapter; repository main can be ahead of the npm release. After reconnecting, call:

```json
{"name":"open_binary","arguments":{"path":"/absolute/path/to/program","provider_id":"ida"}}
{"name":"analyze_function","arguments":{"procedure":"main"}}
{"name":"search_strings","arguments":{"pattern":"license"}}
{"name":"close_binary","arguments":{}}
```

Opening an MCP target starts its selected provider session; headless opening waits for auto-analysis. Set the agent's MCP request deadline long enough for the target. The registration's optional `timeoutMs` defaults to 300000 for upstream requests. A freshly opened headless worker can briefly report `status: "busy"` from `server_health`; REA re-reads the health every 100 ms until the worker answers, the caller cancels, or `timeoutMs` has elapsed since the first read. Only expiry while the worker is still busy produces a retryable `provider_timeout`; no further read is started once the deadline has passed. That error names the busy tool of the last observation, or `unknown` when the worker reported none or a value that is not tool-name-shaped. Cancellation during the wait produces `cancelled`. Any other unexpected health payload, including a busy payload with an invalid shape, remains `unreadable_output`. Cancellation drains the current upstream request before cleanup; it does not force-stop GUI analysis. An open request that times out without a completed response retains the private workspace because worker inventory alone cannot prove the request has stopped. `binary_session` reports actual tool availability. Repeated doctor/setup calls are unnecessary when the registration already works.

For guided registration, set `REA_IDA_MCP_CONFIG` before `rea setup --client <client>`. Setup includes that file reference in its reviewed plan and preserves it after approval; it does not copy upstream credentials into the agent configuration. `rea doctor --provider ida --json` validates the registration without starting IDA and explicitly leaves runtime compatibility and target binding for analysis.

## Coverage and evidence

All profiles support procedure/string inventory and literal or regex search, procedure resolution, pseudocode, assembly, raw function instructions, resolved callees, incoming address references, and a function dossier. Inventories and modern pseudocode/assembly follow upstream pagination. Upstream limits on modern xrefs and callees are retained as explicit truncation limitations. In the modern headless profile, targets that are not proven x86-only use processor-neutral `callgraph` edges instead of the x86 instruction checks in upstream `callees` (mrexodia/ida-pro-mcp#549). REA requests depth zero: the pinned upstream emits the root's outgoing edges without scanning child functions, then REA batches function-name lookup for those addresses. The graph covers recognized function destinations only; imports and other non-function targets remain unknown. A server without `callgraph` returns an empty relationship list with an explicit coverage limitation. Graph and path workflows retain those limitations alongside observed edges. A failed or inconsistent graph reply remains an error. A transport-level truncated preview is rejected rather than reported as complete evidence; the error preserves upstream retrieval guidance.

The modern headless profile also supports `resolve_containing_procedure` and `list_documents`. An address resolves through upstream `lookup_funcs` to the canonical entry of the function that contains it; the body stays unavailable like other IDA identities. When no function contains it, REA reads the database-scoped minimal `survey_binary` and reports `not_in_procedure` for an address inside one of its segments (ends are exclusive) and `outside_segments` otherwise. A missing, truncated or inconsistent survey fails the read instead of guessing a reason. `list_documents` returns the single admitted program path, so `inspect_address_context` and `trace_feature` need no explicit document. `trace_feature` marks a trace truncated, with a residual unknown for that address, when upstream caps the references it returned. The legacy and native profiles do not declare these operations.

The legacy profile additionally supports direct callers. Its producer may report call-site or interior addresses; REA resolves the reported function symbol to its canonical entry. The modern and native profiles do not prove direct callers from its code/data xref labels, so that capability is unavailable and the dossier marks it unknown.

Complete body ranges, typed reference edges, CFG, referenced data, source locals, comment kinds, and database revision are unavailable. Empty unsupported dossier facets mean **unknown**, not observed absence. `binary_overview`, whole-symbol inventory, mutation, debugging, arbitrary Python forwarding, and requested GUI navigation are outside this adapter's coverage. Check session availability before composing a workflow that needs those facets.

`provider.version` identifies the REA adapter; the profile explicitly records `version_scope: "rea-ida-adapter"`. The MCP handshake's `serverInfo` is separate and does not establish IDA or Python distribution versions. Raw observations preserve producer metadata and output. Attached hashes identify the recorded original input; headless identity uses the digest-verified private copy and observed worker input path. Neither proves source-code recovery or an unmodified analysis database.

## Verification

Run `npm run verify:ida -- --target /absolute/path/to/program --procedure main` with a configured upstream server. It exercises production CLI and MCP tools, validates their output contracts and Evidence, checks original-input preservation and session cleanup, and keeps local target data out of its console summary. Supply `--package-root` to verify an extracted or installed package. See [testing](testing.md) for the distinction between adapter tests and real-provider evidence.

Native verification requires `--second-procedure other_function --second-marker unique_second_body_text`; these options remain optional for the other profiles. The marker must occur in the second function's pseudocode and be absent from the first; the verifier also checks that returning to the first restores its text.

The verifier requires the resolved procedure in both inventory and procedure search, then compares address, assembly, pseudocode, instruction windows and relationship results with the CLI/MCP dossier. Supply `--expected-string known_literal` to check a known positive string inventory/search result and `--expected-xref 0xSOURCE` to check a known reference source address. Choose those oracles independently from the operation under test. Without them, string and xref correctness are listed in `unverified`; valid output shapes alone do not establish those behaviors. Callee parity does not independently establish semantic completeness. Native callee successes must report an explicit truncation marker; missing markers remain protocol failures.

The initial real workflows use stdio registrations for the legacy Windows GUI profile and a Windows x64 headless supervisor with IDA 9.3. The headless workflow has also passed on macOS arm64 with IDA Professional 9.1 (build 9.1.250226) against the same upstream commit `c133c3853faa111a9b00ee615c013b720d0c4acd`, using a source-built arm64 Mach-O fixture; Mach-O C symbols carry a leading underscore, so the procedure name is `_rea_fixture_add`. Streamable HTTP is tested against a loopback MCP fixture with the pinned client SDK; a real IDA HTTP-supervisor workflow remains unverified. Linux headless engine operation, other IDA releases, architectures, and modern attached GUI tools require their corresponding real workflows before support is claimed.

Native Windows verification uses IDA Pro 9.3 with the public two-function fixture and Windows `whoami.exe`, using upstream `c9d15d98e8a143fc74f6e14037c48f63889b6d6c` with a loopback-listener change. It covers production CLI/MCP parity, distinct-function switching, identity and connection cleanup. See the [correctness and performance measurements](https://github.com/morluto/rea/blob/main/experiments/analysis-efficiency/ida-native-windows.md). This follow-up did not run Windows IDA Free or native macOS.
