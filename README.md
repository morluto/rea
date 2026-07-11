# betterBinaryMCP

A TypeScript MCP server for [Hopper Disassembler](https://www.hopperapp.com/). It preserves 31 familiar Hopper operations and adds 8 reverse-engineering workflows for Swift, Objective-C, decompilation, call graphs, cross-references, and binary summaries.

The server uses the modular `@modelcontextprotocol/server@2.0.0-beta.3` SDK.

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

## Requirements

- Node.js 20 or newer
- Hopper Disassembler 6+ on macOS
- A binary or Hopper database to analyze

Accessibility permission is **not** required. Specify loader arguments for archives that would otherwise show an architecture chooser.

## Install and Build

```bash
npm ci
npm run build
```

## MCP Configuration

Build the project, then configure your MCP client with an absolute path:

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

Run it directly with `npm start` after building. Stdout is reserved for MCP protocol messages; diagnostics use stderr.

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

MIT — see [LICENSE](LICENSE).
