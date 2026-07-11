# REA

REA is agent-ready Hopper Disassembler tooling: one CLI with a beta.3 MCP mode, 31 official proxies, 8 enhanced reverse-engineering workflows, and 3 binary-session tools.

## Install from this checkout

Requires macOS 12+ and Node.js 22+.

```bash
npm ci
npm run build
npm link
rea setup --yes
```

`setup` is safe to repeat. It checks the host, installs Homebrew when approved and absent, installs Hopper from the official `hopper-disassembler` cask, and finishes with structured diagnostics. It never bundles Hopper or publishes this private package.

The CLI and MCP adapter share the same binary-session core. Source-checkout development uses `npm link`; packaged verification uses a local tarball and does not require a published package.

Useful onboarding commands:

```bash
rea --help
rea --llms
rea doctor --target /path/to/binary
rea skills add
rea mcp add
```

## MCP workflow

Start the MCP adapter with `rea mcp` (or `rea --mcp`) with no target. In the connected agent:

1. Call `open_binary` with any readable local binary or `.hop` path.
2. Call `binary_overview`, then use decompilation, strings, symbols, and xrefs tools.
3. Call `open_binary` again to switch targets; a failed switch preserves the current target.
4. Call `close_binary` when finished. `binary_session` reports current state.

Relative target paths resolve against the MCP server's working directory. Mach-O/FAT, ELF, PE, and Hopper databases are detected automatically. FAT loading selects the host-compatible architecture.

`HOPPER_TARGET_PATH` remains supported for older configurations but is optional. `HOPPER_LAUNCHER_PATH`, `HOPPER_TARGET_KIND`, and `HOPPER_LOADER_ARGS_JSON` retain their existing meanings for legacy startup configuration.

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

## Development and verification

```bash
npm run check
npm pack --dry-run
npm run verify:package
HOPPER_TARGET_PATH=/path/to/target-a \
HOPPER_SECOND_TARGET_PATH=/path/to/distinct-target-b \
npm run verify:hopper
```

Real-Hopper verification requires Hopper and a representative target. The stdio server uses only the repository's authenticated Unix-socket bridge; Hopper's bundled MCP server is not used.

The package, executable, MCP, skill, and config names are centralized in `src/identity.ts`. The package remains private and is not ready for publication.

The package deliberately ships only the `rea` executable. A future zero-install setup will use the floating registration `npx -y @morluto/rea mcp`; local tarballs exercise the same packaged command before publication:

```bash
npm pack
npm exec --yes --package ./morluto-rea-0.1.0.tgz -- rea --help
```

## License

MIT, see [LICENSE](LICENSE).
