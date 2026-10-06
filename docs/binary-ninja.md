# Binary Ninja MCP backend

REA has an experimental `binary-ninja` provider for Binary Ninja's **built-in MCP server**. It connects as an MCP client while exposing REA's existing CLI, MCP tools, session selection, and Evidence results. It requires no Hopper or Ghidra installation.

The built-in server differs from third-party plugins named `binary_ninja_mcp`. This adapter targets the `bn_*` tools and opaque `openItem`/`binaryView` handles described in [Binary Ninja's official MCP guide](https://dev-docs.binary.ninja/guide/mcp.html). Exact tool names and output schemas depend on the installed version. REA discovers advertised tools, sends only advertised arguments, and rejects unsupported roles or unrecognized output rather than interpreting them as empty results.

## Build this checkout

```sh
npm ci
npm run build:cached
```

Use `node scripts/rea.mjs` to run this modified checkout. `npx rea-agents@latest` runs the upstream package and does not include these changes.

## GUI server: HTTP

In Binary Ninja, enable `ui.mcp.enabled`, restart, and select **Plugins > MCP > Start Server**. Use **Copy Connection Info** for the actual URL. The documented default is `http://127.0.0.1:24642/mcp`.

```sh
export REA_ANALYSIS_PROVIDER=binary-ninja
export REA_BINARY_NINJA_MCP_URL=http://127.0.0.1:24642/mcp
# Only when ui.mcp.token is configured:
export REA_BINARY_NINJA_MCP_TOKEN='your-token'

node scripts/rea.mjs doctor --provider binary-ninja --json
node scripts/rea.mjs providers --json
node scripts/rea.mjs analyze /absolute/path/to/program --provider binary-ninja
node scripts/rea.mjs decompile /absolute/path/to/program 0x401000 --provider binary-ninja
```

Use an address actually observed in your binary. Only loopback HTTP/HTTPS endpoints are accepted, and redirects are refused. Put credentials in the token variable, not the URL. GUI availability follows your installed edition/version; versions without the built-in MCP setting need an update or a different adapter.

REA imports its own temporary copy even when the original is already open. It closes only the item whose handle it received and never saves or closes your existing analysis. The active view is selected explicitly, but external GUI/MCP clients can change shared state during a request. A dedicated headless server avoids GUI interference.

## Headless server: stdio

The official guide documents `binaryninja_mcp` for Commercial/Ultimate editions on macOS/Linux. Native Windows packages currently use the GUI HTTP server; headless operation under WSL needs the Linux installation. REA's other host requirements continue to apply.

Unset HTTP variables before selecting stdio:

```sh
unset REA_BINARY_NINJA_MCP_URL REA_BINARY_NINJA_MCP_TOKEN
export REA_ANALYSIS_PROVIDER=binary-ninja
export REA_BINARY_NINJA_MCP_COMMAND=/absolute/path/to/binaryninja_mcp
export REA_BINARY_NINJA_MCP_ARGS_JSON='["-p"]'
node scripts/rea.mjs doctor --provider binary-ninja --json
node scripts/rea.mjs analyze /absolute/path/to/program --provider binary-ninja
```

`-p` disables user/Extension Manager plugins in the built-in server. Arguments default to `[]`; command paths must be absolute. REA owns the stdio child through the MCP SDK and closes it with the session. It does not install Binary Ninja, change its license, or run the target executable.

## Use REA from an MCP client

Configure the client to run this checkout's launcher and pass the backend environment variables:

```json
{
  "mcpServers": {
    "rea": {
      "command": "node",
      "args": ["/absolute/path/to/rea/scripts/rea.mjs", "mcp"],
      "env": {
        "REA_ANALYSIS_PROVIDER": "binary-ninja",
        "REA_BINARY_NINJA_MCP_URL": "http://127.0.0.1:24642/mcp"
      }
    }
  }
}
```

Use your client's credential mechanism or inherited environment for `REA_BINARY_NINJA_MCP_TOKEN`. Credentials are excluded from profile commitments and redacted from transport diagnostics. Guided setup does not automatically persist this backend's connection settings; configure them explicitly in the client.

Open a target with `open_binary` and `provider_id: "binary-ninja"`, then use ordinary REA tools. `REA_ANALYSIS_PROVIDER=binary-ninja` supplies the same default. Auto selection remains ambiguous when multiple configured providers support a target; select explicitly.

## Coverage and limits

The adapter implements function, symbol, string, and segment inventories; literal/regex searches; exact function resolution; pseudocode/disassembly; callers/callees; function metadata; byte reads; address references; raw instruction lists; and an `analyze_function` dossier. REA composes its normal binary overview and compatible workflows from these operations. Queries depend on the server advertising the corresponding tools.

Inventories drain `nextOffset` pagination. Addresses remain hexadecimal strings, including those above JavaScript's safe integer range. Reads report returned byte counts and completeness. Digest checks reject files changed after target selection.

Admission covers native ELF, PE, and thin Mach-O executables supported by REA's parser. Databases, universal Mach-O selection, DOS loader profiles, annotations, saving, and GUI controls are unsupported. Dossiers mark complete body ranges, locals, comments, typed reference edges, referenced strings/names, CFG blocks, and native API/value-flow data as unobserved. Empty collections for these facets are not proof of absence. Profiles record the MCP-advertised version and mapped tools; they do not independently attest engine build or analysis settings.

`REA_BINARY_NINJA_MCP_TIMEOUT_MS` defaults to `300000` per request and must be positive. Cancellation is forwarded to the SDK. Open-file requests finish acquiring their ownership handle before cleanup so REA can close its own item. If closure cannot be verified, REA reports failure and retains the temporary copy.

## Verification and compatibility diagnosis

Deterministic tests use synthetic servers with the documented calling conventions. They cover in-memory MCP, authenticated loopback HTTP, and the packaged CLI over a real stdio child. They establish adapter/transport behavior; **real Binary Ninja engine compatibility has not been verified in the implementation environment**.

Run the real-provider lane against your installation and a native executable:

```sh
npm run verify:binary-ninja -- /absolute/path/to/program
```

It opens a target, drains functions, requests pseudocode, composes a dossier/overview, and checks cleanup. It fails when the configured server is absent; synthetic tests do not replace it.

For rejected mappings or result formats, capture the server's schemas without opening a target:

```sh
node scripts/inspect-binary-ninja-mcp.mjs
```

Mappings live in `src/binaryNinja/BinaryNinjaMcp.ts`; projections live in `BinaryNinjaValues.ts` and `BinaryNinjaSession.ts`. Extend support using observed schemas and regression fixtures. A third-party plugin is a separate protocol and needs its own adapter.
