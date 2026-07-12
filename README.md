# REA

REA gives coding agents access to Hopper Disassembler through one `rea` command. It exposes 42 MCP tools: 31 direct Hopper operations, 8 composed analysis workflows, and 3 target-session tools.

REA uses Hopper's public Python API through its own authenticated local bridge. It does not use Hopper's bundled MCP server.

## Requirements

- macOS 12 or newer
- Node.js 22 or newer
- Hopper Disassembler

REA does not bundle Hopper. `rea setup --yes` can install Homebrew when absent, install Hopper with the `hopper-disassembler` Homebrew cask, configure detected MCP clients, and install the REA agent skill. Setup is idempotent and returns structured remediation when an installer needs human attention.

## Install

After publication:

```bash
npx -y @morluto/rea setup --yes
npx -y @morluto/rea doctor
```

For source-checkout development:

```bash
npm ci
npm run build
npm link
rea setup --yes
```

The CLI and MCP adapter call the same binary-session runtime directly; neither invokes the other. One-shot `analyze` and `decompile` commands close their bridge session before returning. MCP mode keeps one session alive so an agent can switch targets.

```bash
rea --help
rea --llms
rea doctor --target /path/to/binary
rea mcp add
```

## MCP workflow

Start the MCP adapter with `rea mcp` (or `rea --mcp`) with no target. In the connected agent:

1. Call `open_binary` with any readable local binary or `.hop` path.
2. Call `binary_overview`, then use decompilation, strings, symbols, and xrefs tools.
3. Call `open_binary` again to switch targets. If the new target fails, REA attempts to reopen the previous target.
4. Call `close_binary` when finished. `binary_session` reports current state.

Relative target paths resolve against the MCP server's working directory. Mach-O/FAT, ELF, PE, and Hopper databases are detected automatically. FAT loading selects the host-compatible architecture.

`HOPPER_TARGET_PATH` is optional and opens an initial target at server startup. `HOPPER_LAUNCHER_PATH` overrides the Hopper launcher. `HOPPER_TARGET_KIND` selects `executable` or `database` for an initial target. `HOPPER_LOADER_ARGS_JSON` overrides REA's derived Hopper loader arguments for supported executable formats.

Manual target-free MCP configuration:

```json
{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ["-y", "@morluto/rea", "mcp"]
    }
  }
}
```

The first `open_binary` can take time while Hopper analyzes the file. Analysis calls made without an open target return an actionable `NoBinaryOpenError`.

## Hopper application behavior

REA starts Hopper when needed; Hopper does not have to be running first. Hopper's launcher internally activates the application, so opening a target may bring Hopper to the foreground. REA asks macOS to start Hopper hidden and in the background when possible, but cannot guarantee that Hopper will remain behind the current application.

Explicit format and architecture loader arguments prevent Hopper's common FAT/ARM selection dialogs. Other Hopper or macOS dialogs can still require a person. REA reports timeouts and setup remediation through the CLI or MCP result instead of trying to answer UI prompts.

Closing a REA session shuts down its bridge and removes its private socket directory. It does not quit a Hopper application the user may be using.

## Local security boundary

Each bridge session uses a random capability token and a Unix socket restricted to the current user. This rejects unauthenticated connections and access from other local user accounts, but it does not defend against a malicious process already running as the same user. REA bounds protocol messages and exposes sanitized error messages instead of launcher stderr or internal exception causes.

This boundary prevents unrelated local processes from accidentally using a bridge session; it is not a sandbox. Opening an untrusted binary still delegates parsing and analysis to Hopper under the current macOS user account.

## Development and verification

```bash
npm run check
npm pack --dry-run
npm run verify:package
HOPPER_TARGET_PATH=/path/to/target-a \
HOPPER_SECOND_TARGET_PATH=/path/to/distinct-target-b \
npm run verify:hopper
```

Real-Hopper verification requires Hopper and two distinct binaries. It checks target-free startup, all 42 tools, analysis, bounded decompilation, target switching, bridge cleanup, and server shutdown. The verifier terminates only Hopper bundle processes that appeared during its run; it preserves Hopper processes that were already running.

Before publishing a release, run `npm run check`, `npm run verify:package`, `npm pack --dry-run`, and the two-target real-Hopper verifier. After publication, repeat the CLI and MCP smoke tests through `npx -y @morluto/rea`.

The package ships only the `rea` executable. Setup writes a floating MCP registration using `npx -y @morluto/rea mcp`. A local tarball exercises the same package boundary before publication:

```bash
npm pack
npm exec --yes --package ./morluto-rea-0.1.0.tgz -- rea --help
```

## License

MIT, see [LICENSE](LICENSE).
