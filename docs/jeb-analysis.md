# JEB instrumentation and analysis

REA exposes JEB-backed project, unit, and decompilation inspection through the CLI and MCP, served by JEB's own MCP interface. JEB is a bring-your-own engine: REA never installs it, launches it, or opens its project databases itself.

## Bring-your-own engine

Start a JEB client that serves MCP and point REA at it:

- Default endpoint: `http://127.0.0.1:8425/mcp`. Override with `REA_JEB_MCP_URL` (absolute `http`/`https` URL; credentials, query strings, and fragments are rejected rather than silently dropped).
- In the JEB GUI client, start the MCP server from the _File_ menu (or via the VIBRE assistant).
- Headless, use JEB's documented programmatic route (`JebMcpServerInstance` from the JEB API) with the JEB client on your classpath; JEB 5.48's `-c` headless mode does not accept `--mcp` directly.

Verified against JEB 5.48.0 (Linux x64, licensed build) serving `jeb-mcp-server` 1.3.0 over streamable HTTP.

## Operations

| MCP tool / CLI command                      | Purpose                                                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `inspect_jeb_client` / `inspect-jeb-client` | Engine version, GUI or headless mode, startup time                                                                              |
| `open_jeb_project` / `open-jeb-project`     | Open or create a project from an artifact or `.jdb2` on the engine host; returns input-file SHA-256 digests and top-level units |
| `list_jeb_units` / `list-jeb-units`         | Page units by stable path and type (`filter`, `parent-unit-path`, `index`, `count`)                                             |
| `decompile_jeb_item` / `decompile-jeb-item` | Decompile one type or method to engine pseudo-code                                                                              |

All four are read-only with respect to the target file; only `open_jeb_project` changes engine-side project state, and Evidence records the endpoint, the caller-selected parameters, and the engine-reported digests. Mutation workflows the engine also offers (renames, comments, `save_project`, `close_project`) are intentionally not exposed yet.

**Engine coverage note (verified):** JEB 5.48.0 headless MCP instances do not advertise `open_project` — the target must be selected when the engine client starts (`--infile` on the programmatic launcher, or the GUI's file opening). REA preserves that refusal with the engine's reason instead of failing silently; `open_jeb_project` completes only against engine builds that advertise the tool, such as GUI clients.

## Semantics

- Paths in `open_jeb_project` are resolved by the JEB process, not by REA; REA does not require the artifact to exist locally.
- The engine caps `list_units` pages at 100; a full page is reported as `coverage: "partial"` because more units may exist. An empty remainder is `complete` only when fewer units than requested were returned.
- When `decompile_jeb_item` omits `unit_path`, the engine implicitly selects the project's first code unit; REA reports `unit_path: null` and a limitation instead of guessing the effective unit.
- Engine refusals (`success: false` envelopes) are preserved as unsupported-target errors carrying the engine's own message, for example a nonexistent item address.
- An unreachable endpoint is a provider-availability failure with recovery guidance; REA does not retry or spawn the engine.

Real-engine verification lives in the JEB lane described in [testing.md](testing.md); mock transport tests do not establish real-engine compatibility.
