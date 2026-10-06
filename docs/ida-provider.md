# IDA Pro provider

REA adapts an existing [mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp) server into its native analysis tools. Install and configure IDA, Hex-Rays, Python, and upstream MCP using that repository's instructions. REA does not install, upgrade, activate, or license them, and does not bundle another IDA server.

Choose one lifecycle mode in an upstream MCP JSON registration. Set `REA_IDA_MCP_CONFIG` to that file, then select `ida` once through `REA_ANALYSIS_PROVIDER`, the CLI's `--provider ida`, or MCP's `open_binary.provider_id`. No provider startup occurs during discovery.

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

REA copies the admitted binary into a private temporary directory, checks its digest, and requests an owned worker with `force_headless`. POSIX workspaces use mode `0700`; Windows uses the matching package's native private-DACL boundary on a local NTFS temporary directory. It injects the returned database ID into analysis requests. It verifies the active owned worker and input path rather than adopting a user database. On close or failed startup, it releases its session with `save: false`, verifies that it is absent from upstream session discovery, and removes its private input and sidecars. An unverified release retains the workspace and reports incomplete cleanup.

One REA session owns one database. Stdio registrations default `IDA_MCP_MAX_WORKERS` to `1`; the explicit upstream `--max-workers 1` also bounds a supervisor. Database size and engine memory depend on the target and upstream; REA does not impose an engine memory limit. The original binary is never executed or overwritten. Optional `workspaceRoot` selects an existing absolute temporary-directory parent on the REA host. Ensure it has space for the input copy and IDA working files.

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

Opening an MCP target starts its selected provider session; headless opening waits for auto-analysis. Set the agent's MCP request deadline long enough for the target. The registration's optional `timeoutMs` defaults to 300000 for upstream requests. Cancellation drains the current upstream request before cleanup; it does not force-stop GUI analysis. An open request that times out without a completed response retains the private workspace because worker inventory alone cannot prove the request has stopped. `binary_session` reports actual tool availability. Repeated doctor/setup calls are unnecessary when the registration already works.

For guided registration, set `REA_IDA_MCP_CONFIG` before `rea setup --client <client>`. Setup includes that file reference in its reviewed plan and preserves it after approval; it does not copy upstream credentials into the agent configuration. `rea doctor --provider ida --json` validates the registration without starting IDA and explicitly leaves runtime compatibility and target binding for analysis.

## Coverage and evidence

Both profiles support procedure/string inventory and literal or regex search, procedure resolution, pseudocode, assembly, raw function instructions, resolved callees, incoming address references, and a function dossier. Inventories and modern pseudocode/assembly follow upstream pagination. Upstream limits on modern xrefs and callees are retained as explicit truncation limitations. A transport-level truncated preview is rejected rather than reported as complete evidence; the error preserves upstream retrieval guidance.

The legacy profile additionally supports direct callers. Its producer may report call-site or interior addresses; REA resolves the reported function symbol to its canonical entry. The modern profile does not prove direct callers from its code/data xref labels, so that capability is unavailable and the dossier marks it unknown.

Complete body ranges, typed reference edges, CFG, referenced data, source locals, comment kinds, and database revision are unavailable. Empty unsupported dossier facets mean **unknown**, not observed absence. `binary_overview`, whole-symbol inventory, mutation, debugging, arbitrary Python forwarding, and GUI navigation are outside this adapter's coverage. Check session availability before composing a workflow that needs those facets.

`provider.version` identifies the REA adapter; the profile explicitly records `version_scope: "rea-ida-adapter"`. The MCP handshake's `serverInfo` is separate and does not establish IDA or Python distribution versions. Raw observations preserve producer metadata and output. Attached hashes identify the recorded original input; headless identity uses the digest-verified private copy and observed worker input path. Neither proves source-code recovery or an unmodified analysis database.

## Verification

Run `npm run verify:ida -- --target /absolute/path/to/program --procedure main` with a configured upstream server. It exercises production CLI and MCP tools, validates their output contracts and Evidence, checks original-input preservation and session cleanup, and keeps local target data out of its console summary. Supply `--package-root` to verify an extracted or installed package. See [testing](testing.md) for the distinction between adapter tests and real-provider evidence.

The initial real workflows use stdio registrations for the legacy Windows GUI profile and a Windows x64 headless supervisor with IDA 9.3. Streamable HTTP is tested against a loopback MCP fixture with the pinned client SDK; a real IDA HTTP-supervisor workflow remains unverified. Linux/macOS headless engine operation, other IDA releases, architectures, and modern attached GUI tools require their corresponding real workflows before support is claimed.
