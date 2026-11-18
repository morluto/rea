# Windows x64 portable runtime (#1316)

Issue: https://github.com/morluto/rea/issues/1316

## Outcome

Produce an experimental, relocatable Windows x64 directory that contains REA,
its locked production dependencies, the Windows native authority module, and an
official Node runtime. A destination machine can start the CLI or MCP server and
configure a client offline without npm or a dependency download.

## Requirements

- Build on Windows x64 with `npm run package:portable:windows --
  --node-directory <extracted Node> --output-directory <new directory>`. The
  command requires the pinned `.nvmrc` version, a Windows x64 Node distribution,
  and the existing built application and native artifact; it does not download
  Node.
- Reject an existing output directory. On failure retain the partial directory
  without `portable.json`; publish that completion marker only after every
  output file and the manifest are written.
- Assemble `npm pack` application files, the win32/x64 selection of the locked
  production dependency tree, `node.exe` with its license, the launchers, and a
  copy of the portable guide as the package README.
- Provide `rea.ps1` for PowerShell and `rea.cmd` for Command Prompt, both using
  the bundled `runtime/node.exe`. The PowerShell entrypoint preserves literal
  `%NAME%` and `!NAME!` paths and forwards stdio for live MCP; the batch entrypoint
  forwards ordinary Command Prompt arguments. `runtime/launch.mjs` clears the
  package-runner marker and imports `app/scripts/rea.mjs` with the bundled
  entrypoint identity.
- Record every regular output file with its size and SHA-256 in `portable.json`,
  plus the runtime and selected dependency versions. The manifest is an
  inventory, not a signature or an OS-level trust boundary.
- Verify an extracted directory with `npm run verify:portable:windows --
  --directory <directory>`. Require the exact regular-file set and parent
  directories, rejecting stale files, non-regular entries, and unlisted empty
  directories that can shadow Node resolution. Verify declared sizes and hashes
  with bounded reads before executing the artifact.
- Exercise the shipped launchers unchanged: literal PowerShell arguments and
  exit status, relative target paths after `Set-Location`, captured and piped
  JSON output, offline setup and doctor, repeated setup without additional
  writes, CLI/MCP static JavaScript analysis parity, source preservation, and
  uninstall in an isolated profile. Run the same check under Windows PowerShell
  5.1 and PowerShell 7.
- Keep the Windows curated CI lane as the executable proof. Route changes to the
  packaged guide through the package lane, including its modification, deletion,
  or rename.
- Document preparation, verification, relocation, offline limits, and the
  absence of bundled external engines in `docs/portable-windows.md`.

## Acceptance and limits

Focused tests cover dependency platform selection, missing dependencies, exact
file and digest checks, bounded manifest and traversal handling, literal Windows
paths and arguments, launcher descendant cleanup, and CI package-lane routing.
The Windows lane prepares a real directory under a path containing spaces,
Unicode, `%PATH%`, `&`, and `!NAME!`, then runs both shell verifiers.

Windows x64 is the only packaged platform. Ghidra, Java, Hopper, browsers, and
other optional tools are not bundled or verified by this check. The Node
socket-connection preload is a verification control, not an OS firewall. The
inventory does not authenticate the artifact, and automatic release uploads,
automatic updates, and offline provider downloads are outside this feature.

## Non-goals

- Linux, macOS, or Windows ARM64 packages.
- Replacing the existing npm package or managed installation workflows.
- A general-purpose installer, service manager, or signature/verification
  authority beyond the recorded inventory.
