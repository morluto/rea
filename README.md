# betterBinaryMCP

A TypeScript MCP server for [Hopper Disassembler](https://www.hopperapp.com/). It preserves 31 Hopper operations and adds 8 reverse-engineering workflows for Swift, Objective-C, decompilation, call graphs, cross-references, and binary summaries.

## Prerequisites

Check these before you start:

- **Node.js 20+** (`node --version`)
- **Hopper Disassembler 6+** on macOS, at `/Applications/Hopper Disassembler.app/`
- **A binary to analyze** (Mach-O executable, `.dylib`, `.hop` database, etc.)

Accessibility permission is not required.

## Quick Start

```bash
git clone https://github.com/morluto/betterBinaryMCP.git && cd betterBinaryMCP
npm ci && npm run build
```

Generate an MCP config with absolute paths filled in:

```bash
npm run config:print -- /path/to/your/binary
```

Paste the output into your client's MCP config file:

| Client            | Config path                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| Claude Desktop    | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Cursor            | `.cursor/mcp.json` in your project root                                   |
| Other MCP clients | Check the client's docs for MCP server config                             |

Restart the client. The 39 tools appear in the tool list.

```bash
# For a .hop database:
npm run config:print -- /path/to/file.hop --kind database

# For a FAT binary that needs loader args:
npm run config:print -- /path/to/binary --loader-args '["-l","Mach-O","--aarch64"]'
```

### What happens on first tool call

The server does not launch Hopper at startup. Hopper launches lazily on the first tool call that needs it, which means the first call can take 10-30 seconds while Hopper opens and analyzes the binary. Subsequent calls are fast. If the first call times out, see [Troubleshooting](#troubleshooting).

### Try it

Once connected, call `binary_overview` with no arguments. It returns segment layout, procedure count, and string count. If you get JSON back, the server is working.

### Set up with your agent

Paste this prompt into Claude, Cursor, or any MCP-capable agent to have it do the setup for you:

> I want to connect betterBinaryMCP (a Hopper Disassembler MCP server) to this client.
>
> 1. Clone `https://github.com/morluto/betterBinaryMCP.git` and run `npm ci && npm run build`.
> 2. Run `npm run config:print -- /path/to/my/binary` to generate the MCP server config.
> 3. Paste the output into this client's MCP config and restart.
> 4. Call `binary_overview` with no arguments to verify the server is working.

## Architecture

```text
MCP client ← stdio → TypeScript MCP server ← Unix socket → owned Python bridge → Hopper.app
```

The codebase is a layered ESM TypeScript application. Dependencies flow inward: `domain` ← `contracts` ← `hopper` ← `application` ← `server` ← `main`.

- `src/main.ts` is the composition root: it parses config, wires the Hopper client, starts the stdio MCP transport, and owns process-lifetime shutdown.
- `src/hopper/` lazily launches Hopper on the first Hopper-dependent tool and correlates bounded bridge messages, so lengthy analysis does not block the MCP handshake.
- `bridge/hopper_bridge.py` runs inside Hopper and calls its public Python API. Hopper's bundled MCP server is not executed or required.
- `src/application/` composes official operations into the 8 enhanced tools.
- `src/domain/` holds pure parsers and the tagged error algebra; `src/contracts/` declares the caller-visible tool schemas.

## Manual MCP Configuration

If you prefer to write the config by hand, build the project and use absolute paths:

```json
{
  "mcpServers": {
    "betterBinaryMCP": {
      "command": "node",
      "args": ["/absolute/path/to/betterBinaryMCP/dist/main.js"],
      "env": {
        "HOPPER_TARGET_PATH": "/absolute/path/to/binary"
      }
    }
  }
}
```

Stdout is reserved for MCP protocol messages; diagnostics use stderr.

### Environment Variables

| Variable                  | Required | Default                                                       | Description                                                            |
| ------------------------- | -------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `HOPPER_TARGET_PATH`      | yes      | —                                                             | Absolute path to the binary or `.hop` database to analyze.             |
| `HOPPER_LAUNCHER_PATH`    | no       | `/Applications/Hopper Disassembler.app/Contents/MacOS/hopper` | Override the Hopper executable path.                                   |
| `HOPPER_TARGET_KIND`      | no       | `executable`                                                  | `executable` or `database` (for `.hop` files).                         |
| `HOPPER_LOADER_ARGS_JSON` | no       | `[]`                                                          | JSON array of strings passed to the Hopper launcher before the target. |

For an Apple FAT binary, for example:

```json
["-l", "FAT", "--aarch64", "-l", "Mach-O"]
```

## Tools

### 31 Official Tools (proxied)

| Tool                                                                                                      | Description                        |
| --------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `address_name`                                                                                            | Get the name (label) at an address |
| `comment` / `inline_comment`                                                                              | Get comments at an address         |
| `current_address` / `current_procedure` / `current_document`                                              | Cursor state                       |
| `goto_address` / `next_address` / `prev_address`                                                          | Navigation                         |
| `list_segments` / `list_procedures` / `list_strings` / `list_names` / `list_documents` / `list_bookmarks` | Listing                            |
| `search_procedures` / `search_strings`                                                                    | Regex search                       |
| `procedure_pseudo_code` / `procedure_assembly`                                                            | Decompilation                      |
| `procedure_callees` / `procedure_callers`                                                                 | Call relationships                 |
| `procedure_info` / `procedure_address`                                                                    | Procedure metadata                 |
| `set_address_name` / `set_addresses_names`                                                                | Rename labels                      |
| `set_comment` / `set_inline_comment`                                                                      | Write comments                     |
| `set_bookmark` / `unset_bookmark`                                                                         | Bookmarks                          |
| `set_current_document`                                                                                    | Switch active document             |
| `xrefs`                                                                                                   | Cross-references                   |

### 8 Enhanced Tools

| Tool                  | Parameters                                                            | Purpose                                                             |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `binary_overview`     | —                                                                     | Summarize documents, segments, procedures, and strings              |
| `swift_classes`       | `pattern?: string`                                                    | Find Swift `_TtC` class symbols                                     |
| `get_objc_classes`    | `pattern?: string`                                                    | Find Objective-C class labels                                       |
| `get_objc_protocols`  | —                                                                     | Find Objective-C and Swift protocol labels                          |
| `batch_decompile`     | `addresses: string[]` (max 20)                                        | Decompile up to 20 procedures concurrently                          |
| `get_call_graph`      | `address: string`, `direction?: "forward"\|"backward"`, `depth?: 1–5` | Traverse callers or callees to a bounded depth                      |
| `analyze_swift_types` | —                                                                     | Categorize Swift classes, structs, enums, protocols, and extensions |
| `find_xrefs_to_name`  | `name: string`                                                        | Resolve a name and retrieve cross-references                        |

## Development

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run check
```

`npm test` builds first. Tests cover all 39 contracts, every handler through a beta.3 MCP client, bridge failures, concurrency, strict boundary parsing, and the compiled stdio runtime.

Run the real-Hopper verifier with a representative binary and any required loader options:

```bash
HOPPER_TARGET_PATH=/path/to/binary \
HOPPER_LOADER_ARGS_JSON='["-l","Mach-O","--aarch64"]' \
npm run verify:hopper
```

It asserts the exact 39-tool inventory, document access, `binary_overview`, segment reads, a one-procedure bounded decompile, clean protocol output (no stderr), absence of Hopper's bundled MCP process, and clean shutdown (no leaked bridge session directories or lingering processes).

## Troubleshooting

If startup times out, verify the target path and reproduce the generated loader chain with Hopper's `hopper` launcher. A visible loader or save dialog prevents the post-analysis bridge from starting; supply explicit loader/CPU options or close the stale dialog. Granting Accessibility access will not fix this.

`batch_decompile` accepts at most 20 addresses, and `get_call_graph` accepts depths from 1 through 5.

## License

MIT, see [LICENSE](LICENSE).
