# JEB instrumentation and analysis

REA exposes JEB-backed project, unit, and decompilation inspection through the CLI and MCP, served by JEB's own MCP interface. JEB is a bring-your-own engine: REA never installs it, launches it, or opens its project databases itself.

## Bring-your-own engine

Start a JEB client that serves MCP and point REA at it:

- Default endpoint: `http://127.0.0.1:8425/mcp`. Override with `REA_JEB_MCP_URL` (absolute `http`/`https` URL with literal host `127.0.0.1` or `[::1]` and path exactly `/mcp` or `/mcp/`; redirects, remote hosts, credentials, other paths, query strings, and fragments are rejected rather than silently dropped).
- In the JEB GUI client, start the MCP server from the _File_ menu (or via the VIBRE assistant).
- Headless, the official Linux CE build `5.48.0.202610071539` supports `-c --mcp`. From the JEB installation directory, select JDK 21 or newer through `JAVA_HOME`, choose your target and bind explicitly to loopback:

  ```sh
  "$JAVA_HOME/bin/java" -jar bin/app/jeb.jar -c --mcp --interface=127.0.0.1 \
    --port=8425 --infile=/absolute/path/to/target
  ```

  Complete the vendor's first-use EULA and license-key activation when prompted. The Linux audit used an isolated installation, a 1536 MiB Java heap and one active processor inside a separately bounded process family; JVM heap limits alone do not bound the whole family.

- JEB's documented programmatic route (`JebMcpServerInstance` from the JEB API) remains an alternative. The earlier licensed 5.48 headless verification used that route because its CLI did not accept `--mcp`. Check your installed build's `-c --help` and live tool catalog; the version number alone does not establish the launcher options or supported operations.

For setup registration, set `REA_JEB_MCP_URL` in the REA process environment
before running `rea setup`. The approved setup plan preserves the exact selected
URL after validating its syntax. That validation does not establish that the
JEB service is reachable or that a project is open; use the existing
`inspect-jeb-client` command for a read-only service query. A configured but
unprobed JEB endpoint is not included in setup's ready-provider list; setup can
still save its validated registration and show dedicated diagnostic guidance.

When `REA_JEB_MCP_URL` is omitted or empty, doctor validates the same default
endpoint used by the runtime, including when only a timeout is selected. It
reports that effective endpoint as configured but unprobed. Setup saves an
endpoint override only when a nonempty value was explicitly selected; it does
not write the implicit default into the client registration.

MCP `binary_session` probes the live JEB service and its advertised tool catalog.
Availability is reported per operation: a reachable headless client can support
inspection and decompilation while refusing `open_jeb_project`. Catalog discovery
is one deadline across connection and pagination; a responsive server cannot keep
discovery running indefinitely by returning more pages.

Catalog discovery and each `tools/call` share `REA_JEB_MCP_TIMEOUT_MS`. Set it
in REA's launch environment to an integer from 1 to 2147483647 milliseconds,
for example `REA_JEB_MCP_TIMEOUT_MS=300000` for a five-minute budget. Omitted
means the pinned MCP client SDK default of 60000 ms (`@modelcontextprotocol/client`
2.3.1). Restart REA and reconnect to apply a change. Raising the setting raises
both phases. It does not make one end-to-end deadline across a whole CLI or MCP
operation: discovery and each `tools/call` each get that budget. A request that
reaches its budget returns a typed timeout naming the phase and the effective
milliseconds, while caller cancellation remains a cancellation. Allow execution,
cleanup, and delivery headroom in the outer MCP client deadline.

Earlier verification used JEB 5.48.0 (Linux x64, licensed build) serving `jeb-mcp-server` 1.3.0 over streamable HTTP. The official Linux x64 CE build `5.48.0.202610071539` was also verified through real CLI and production stdio MCP native-code workflows; see the [Linux CE audit](https://github.com/morluto/rea/blob/42e1a17d6e6c0487f17be0bae248553c4caba7f7/experiments/analysis-efficiency/jeb-linux-native.md) for measurements and limits. CE verification does not establish licensed/Demo Android decompilation or GUI behavior.

## Operations

| MCP tool / CLI command                      | Purpose                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_jeb_client` / `inspect-jeb-client` | Engine version, GUI or headless mode, startup time                                                                              |
| `open_jeb_project` / `open-jeb-project`     | Open or create a project from an artifact or `.jdb2` on the engine host; returns input-file SHA-256 digests and top-level units |
| `list_jeb_units` / `list-jeb-units`         | Page units by stable path and type (`filter`, `parent-unit-path`, `index`, `count`)                                             |
| `decompile_jeb_item` / `decompile-jeb-item` | Decompile one type or method to engine pseudo-code                                                                              |

All four preserve target-file bytes. `open_jeb_project` selects or creates an engine-side project; analysis queries can populate computed analysis within it. Evidence records the endpoint, caller-selected parameters, and available engine-reported digests. Mutation workflows the engine also offers (renames, comments, `save_project`, `close_project`) are intentionally not exposed yet.

**Engine coverage note:** The earlier licensed 5.48.0 headless verification did not advertise `open_project`; it selected the target when the engine client started. For that build, use `--infile` on the programmatic launcher or open the file in the GUI. The audited CE headless catalog also omitted `open_project`; the verified CLI route above selects its input at startup. Use `binary_session` to inspect the current engine's advertised operations. REA preserves an unavailable tool's refusal; `open_jeb_project` requires an engine that advertises `open_project`. The CE audit does not establish GUI project-opening support.

## Semantics

- Paths in `open_jeb_project` are resolved by the JEB process, not by REA; REA does not require the artifact to exist locally.
- The engine caps `list_units` pages at 100; a full page is reported as `coverage: "partial"` because more units may exist. An empty remainder is `complete` only when fewer units than requested were returned.
- When `decompile_jeb_item` omits `unit_path`, the engine implicitly selects the project's first code unit; REA reports `unit_path: null` and a limitation instead of guessing the effective unit.
- `item_address` is a JEB code-item reference, such as a value returned by the engine's `list_code_items`. Preserve that representation and select its code unit explicitly. For the audited CE SQLite unit, the exported method reference was `sqlite3_libversion_number`; using its raw ELF symbol address did not produce a successful decompilation. File offsets, ELF virtual addresses and engine item references have different semantics. REA currently exposes unit listing, while code-item discovery remains an upstream JEB operation.
- Engine refusals (`success: false` envelopes) are preserved as unsupported-target errors carrying the engine's own message, for example a nonexistent item address.
- Successfully parsed client information is reused for the lifetime of the MCP connection, including when the engine omits its version. Explicit client inspection and availability probes refresh it.
- An unreachable endpoint is a provider-availability failure with recovery guidance; REA does not retry or spawn the engine.

Real-engine verification lives in the JEB lane described in [testing.md](testing.md); mock transport tests do not establish real-engine compatibility.

A project-open refusal retains the selected engine-host artifact path separately
from the service endpoint. Discovery of an unreachable service includes the same
start/configuration recovery as a direct request. If a primary reply completes
before a later client-information lookup fails or is cancelled, the typed failure
retains that reply as partial Evidence. Engine metadata stays unknown; this is not
a claim that the full operation completed.

## Connect an agent once

Add the endpoint to the **REA** MCP entry's environment:

```json
{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ["-y", "rea-agents@<version-with-jeb>", "mcp"],
      "env": {
        "REA_JEB_MCP_URL": "http://127.0.0.1:8425/mcp"
      }
    }
  }
}
```

Use a package version that actually includes this adapter; repository main can be ahead of the npm release. After reconnecting, call:

```json
{"name":"inspect_jeb_client","arguments":{}}
{"name":"open_jeb_project","arguments":{"path":"/artifact/path/on/the/engine/host"}}
{"name":"list_jeb_units","arguments":{"index":0,"count":50}}
{"name":"decompile_jeb_item","arguments":{"item_address":"0x1000","item_kind":"method"}}
```

For guided registration, set `REA_JEB_MCP_URL` before `rea setup --client <client>`. Setup includes that endpoint reference in its reviewed plan and preserves it after approval. `rea doctor --provider jeb --json` validates the endpoint and any selected `REA_JEB_MCP_TIMEOUT_MS` without starting or contacting JEB. Even with valid configuration, it reports `available: false` and a `jeb-availability` check classified as `unknown`; the selected-provider readiness result is unhealthy because this inspection does not establish availability. This syntax-only doctor does not reuse a prior live probe or claim service availability, compatibility or project binding.
