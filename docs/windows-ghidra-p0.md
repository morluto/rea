# Windows Ghidra P0

Status: experimental. This boundary is useful for approved local fixtures, but
it is not general Windows REA support and must not be used for hostile,
sensitive, security-decision, or concurrently mutable targets.

## Supported boundary

The P0 accepts exactly:

- a Windows x64 host;
- Node.js 22.19+ or 24.11+;
- an operator-installed official Ghidra 12.1.2 distribution;
- a 64-bit full JDK 21;
- an explicit native, non-managed, non-DLL x86-64 PE application; and
- the existing 18 read-only Ghidra inventory and function-analysis operations.

Hopper, Ghidra GUI state, mutation, controlled JavaScript replay, process
capture, browser/Electron observation, artifact extraction, and general
Windows feature parity are not implied by this boundary. Managed PE/CLI
inspection remains a separate execution-free provider and is not routed
through Windows Ghidra P0.

REA does not install or upgrade Ghidra, Java, Python, npm, Node.js, Hopper, or
another package on Windows. The production adapter uses the packaged Java
`HeadlessScript`; Python and PyGhidra are not prerequisites.

## Configuration

Install REA, Ghidra, and JDK 21 separately. In PowerShell:

```powershell
npm install --global rea-agents
$env:GHIDRA_INSTALL_DIR = "C:\tools\ghidra_12.1.2_PUBLIC"
$env:JAVA_HOME = "C:\Program Files\Java\jdk-21"
$env:REA_ANALYSIS_PROVIDER = "ghidra"

rea doctor --json
rea providers --json
rea inspect "C:\approved-fixtures\sample.exe" --provider ghidra --format json
```

`rea doctor` checks the x64 host, exact Ghidra release,
`support\analyzeHeadless.bat`, `java.exe`, `javac.exe`, JDK bitness, and JDK
major version. `rea setup` remains unavailable on Windows and makes no changes.

For an MCP client, register the resolved Node entry point and preserve the
three environment variables above. A representative configuration is:

```json
{
  "mcpServers": {
    "rea-windows-ghidra-p0": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\Users\\analyst\\AppData\\Roaming\\npm\\node_modules\\rea-agents\\scripts\\rea.mjs",
        "mcp"
      ],
      "env": {
        "REA_ANALYSIS_PROVIDER": "ghidra",
        "GHIDRA_INSTALL_DIR": "C:\\tools\\ghidra_12.1.2_PUBLIC",
        "JAVA_HOME": "C:\\Program Files\\Java\\jdk-21"
      }
    }
  }
}
```

Resolve the actual global package path on the intended machine; do not copy the
example path blindly. Restart the MCP client after changing its registration.

## Target and import identity

PE parsing records architecture, COFF executable role, and whether the CLI
header data-directory entry is non-empty. Header classification and SHA-256
are read from the same open file handle. Windows admission then rejects:

- non-PE formats;
- x86, ARM, ARM64, or unknown architectures;
- DLL/shared-library and non-executable image roles;
- managed or incompletely classified PE targets; and
- malformed optional headers or data-directory declarations.

After admission, REA copies the target into the ephemeral Ghidra runtime and
requires the snapshot digest to match the admitted SHA-256. Ghidra imports only
that snapshot. Before serving a request, the Java bridge requires Ghidra's
`Program.getExecutableSHA256()` observation to match the same digest. A path
replacement that changes bytes therefore fails before Evidence is created.

This linkage does not establish Windows reparse-point or hostile-path safety.
The current implementation has no handle-based `CreateFileW` authority backend
and no verified no-follow equivalent for every path component.

## Local transport and lifecycle

Linux continues to use a mode-restricted Unix socket. Windows uses a Java
listener bound to `127.0.0.1` on an ephemeral port. The bridge atomically
publishes a bounded endpoint record containing only schema version, literal
loopback host, and port. The random 256-bit request token remains only in the
ephemeral session descriptor and every request is authenticated.

`analyzeHeadless.bat` is invoked through an absolute `cmd.exe` with a fixed
argument sequence, command extensions enabled for the Ghidra script, delayed
expansion disabled, and Node shell execution disabled. Every batch token is
quoted. Paths containing command-interpreter metacharacters are rejected
instead of escaped heuristically.

Close, cancellation, timeout, protocol failure, or provider exit removes the
project and runtime root. Windows P0 uses bounded `taskkill /T /F` process-tree
termination. It does not assign Ghidra to a Job Object and cannot make the same
PID-reuse and descendant-ownership claim as the POSIX process-group backend.

## Known security gates

The following remain explicitly unavailable:

- verified current-user-only DACLs for runtime directories, descriptors, logs,
  snapshots, and endpoint records;
- a DACL-protected Windows named pipe or equivalent OS-identity-restricted IPC;
- reparse-point-safe, handle-based input and output authority;
- Job Object assignment before child execution and kill-on-close proof;
- general extraction containment and filesystem-sensitive workflows; and
- independent security acceptance for hostile or mutable targets.

Successful symlink creation or ConPTY availability does not satisfy any of
these gates. Inspect the machine-readable report with:

```powershell
npm run probe:windows-capabilities
```

## Verification

Hosted CI builds, type-checks, runs the curated Windows tests, records the named
host capability report, packs the real npm artifact, installs it in isolation,
and compares the packaged MCP catalog with `TOOL_CONTRACTS`.

The controlled real-engine lane is intentionally separate:

```powershell
$env:GHIDRA_INSTALL_DIR = "C:\tools\ghidra_12.1.2_PUBLIC"
$env:JAVA_HOME = "C:\Program Files\Java\jdk-21"
npm ci
npm run verify:ghidra:windows
```

The verifier creates an ignored deterministic x86-64 PE fixture, checks its
fixed SHA-256, opens Ghidra 12.1.2 through the production Java bridge, exercises
all 18 admitted operations, verifies the target/snapshot/import digest chain,
and checks endpoint, project, process, and runtime cleanup. The GitHub workflow
accepts only the fixed `real-ghidra-windows` repository-dispatch event against
default-branch `main`, a protected `real-ghidra-windows` environment, and a
self-hosted runner labelled `Windows`, `x64`, and `ghidra-12-1-2`.

Passing this verifier proves the bounded P0 operation claim. It does not close
the DACL, reparse-point, named-pipe, or Job Object gates above.
