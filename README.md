# betterBinaryMCP

An enhanced MCP (Model Context Protocol) server for [Hopper Disassembler](https://www.hopperapp.com/) that wraps the official Hopper 6 MCP server and adds reverse engineering–specific analysis tools.

**No Python injection or plugins needed** — just Hopper open with a binary.

## Architecture

```
MCP Client ←STDIO→ betterBinaryMCP ←STDIO→ Official HopperMCPServer ←XPC→ Hopper.app
```

- Wraps the official `HopperMCPServer` binary as a subprocess
- Proxies all 31 official tools unchanged
- Adds 8 RE-specific tools built on top of official operations

## Tools

### 31 Official Tools (proxied)

| Tool | Description |
|------|-------------|
| `address_name` | Get/set name (label) at an address |
| `comment` / `inline_comment` | Get/set comments |
| `current_address` / `current_procedure` / `current_document` | Cursor state |
| `goto_address` / `next_address` / `prev_address` | Navigation |
| `list_segments` / `list_procedures` / `list_strings` / `list_names` / `list_documents` / `list_bookmarks` | Listing |
| `search_procedures` / `search_strings` | Regex search |
| `procedure_pseudo_code` / `procedure_assembly` | Decompilation |
| `procedure_callees` / `procedure_callers` | Call relationships |
| `procedure_info` / `procedure_address` | Procedure metadata |
| `set_address_name` / `set_addresses_names` | Rename labels |
| `set_comment` / `set_inline_comment` | Write comments |
| `set_bookmark` / `unset_bookmark` | Bookmarks |
| `set_current_document` | Switch active document |
| `xrefs` | Cross-references |

### 8 RE-Specific Tools (added)

| Tool | Description |
|------|-------------|
| `binary_overview()` | Segment layout, procedure/string counts, document info |
| `swift_classes(pattern)` | Swift class hierarchy from mangled `_TtC` names |
| `get_objc_classes(pattern)` | Objective-C class names from labels |
| `get_objc_protocols()` | Objective-C protocol names from labels |
| `batch_decompile(addresses)` | Decompile up to 20 procedures at once |
| `get_call_graph(address, direction, depth)` | Recursive call graph traversal (forward/backward) |
| `analyze_swift_types()` | Categorize all Swift mangled names by module/type/method |
| `find_xrefs_to_name(name)` | Find references by name lookup |

## Requirements

- **Hopper Disassembler** v6+ (ships the official MCP server)
- **Python** 3.10+
- **Hopper open** with a binary loaded and analyzed

## Installation

```bash
pip install fastmcp
```

## Usage

### As an MCP Server (recommended)

Add to your MCP client configuration (Claude Desktop, Cursor, etc.):

```json
{
    "mcpServers": {
        "betterBinaryMCP": {
            "command": "python3",
            "args": ["/path/to/betterBinaryMCP/server.py"]
        }
    }
}
```

### Command Line

```bash
python3 server.py
```

### Test Connection

```bash
python3 hopper_client.py
```

## Testing

```bash
pip install pytest pytest-asyncio
python -m pytest tests/ -v
```

## How It Works

1. On startup, the server launches the official `HopperMCPServer` binary as a subprocess
2. Communicates via NDJSON (newline-delimited JSON) over STDIO — no HTTP, no Content-Length framing
3. Proxied tools forward calls directly to the official server
4. RE tools compose multiple official calls (e.g., `swift_classes` calls `list_procedures` and parses `_TtC` mangled names)

## Limitations

- Requires Hopper 6+ (the official MCP server binary must exist)
- The official server connects to Hopper via XPC — Hopper must be running with a document open
- `batch_decompile` is limited to 20 procedures per call
- `get_call_graph` is limited to depth 5

## License

MIT
