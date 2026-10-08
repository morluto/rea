# Installation and setup

REA separates installing its CLI from configuring external software and agents.

## Start setup

Start setup with:

```bash
npx rea-agents setup
```

If npm asks to download and run REA, that approval applies only to downloading
the package. REA shows its own plan and asks before changing agent configuration
or installing Hopper.

The short command can use a REA version installed in the current project. To
request the latest release explicitly, use:

```bash
npx rea-agents@latest setup
```

REA runs the version npm selects. To update older agent registrations, run the
latest-version command and review its setup plan. For unattended package
downloads, add `--yes` before the package name; this does not approve REA's
setup changes.

For an intentional rollback, make the package request explicit:

```bash
npm exec --yes --package=rea-agents@2.4.0 -- rea setup
```

Setup continues to pin persistent MCP registrations to the exact version that
performed setup. Running current setup later migrates unversioned or older
managed registrations through the normal reviewed setup transaction.

REA supports Node.js 22.x (>=22.19), 24.x (>=24.11), and 26+. Node.js 23, 25, and prereleases are unsupported. It uses the npm already paired with that runtime and never upgrades Node.js, npm, or Homebrew.

Running `npm install rea-agents` without `--global` installs the executable only
in the current project's `node_modules/.bin`; it does not make `rea` available
on the shell `PATH`. Use the setup command above for the guided setup
journey, `npx -y rea-agents@latest` for unattended one-off commands, or install globally
with `npm install --global rea-agents` for a shell-visible `rea` command.

The optional curl wrapper installs only the global npm package:

```bash
curl -fsSL https://raw.githubusercontent.com/morluto/rea/main/install.sh | bash
```

It prints the version, runtime, npm command, and destination before installing. When a controlling terminal exists it starts `rea setup`; otherwise it prints the command to run later.

Pass options with `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/morluto/rea/main/install.sh |
  bash -s -- --dry-run
```

Supported options are `--version <semver>`, `--dry-run`, `--no-setup`, `--no-prompt`, and `--verbose`. Neither `--no-prompt` nor a non-interactive shell grants permission to install external dependencies.

## Released package and main

Repository main documents its current code and generated catalog. `@latest`
selects the npm release, and persistent MCP registrations are pinned to the
version that performed setup. Installing newer instructions does not update a
running server or its registration.

The release checked on **2026-10-07** was **5.0.0** (133 MCP tools), published
from the fixed checkpoint
[`b33236ec`](https://github.com/morluto/rea/releases/tag/rea-agents-5.0.0).
The public CLI, MCP catalog and target-free session, and isolated update from
4.1.0 to 5.0.0 were verified through npm. The artifact includes Windows native
controls, Android/JADX and firmware tools, Ghidra function annotations, and
retained application-Evidence references.

Main's catalog describes the current code. A source build or a subsequent
release containing changes after this checkpoint is required for newer
functionality. Package startup alone does not verify a provider's real
platform workflow.

To check the published version, run `npm view rea-agents dist-tags.latest`.
Use the connected server's actual tool list and advertised input schemas for
feature selection. The same package version string in a development checkout
does not establish that its bytes match the npm tarball. Update a registration
through a reviewed, scoped setup plan, then restart/reconnect the agent.

## Skill-only installation

```bash
npx skills add morluto/rea --skill reverse-engineer-anything
```

This installs agent instructions and bundled references, not REA MCP
registration or analysis engines. Follow the skill's
[conditional connection guide](https://github.com/morluto/rea/blob/main/skill-src/reverse-engineer-anything/SKILL.md#connect-only-when-needed).
Working tools can be used immediately. If tools are missing, inspect the current
client's registration with `doctor --client codex --json` (substitute its client
ID), then plan repairs with `setup --client codex --dry-run --json`. Show and
approve the exact changes before applying that scope. An aligned registration
with tools absent from the active session needs a restart/reconnection;
`doctor` checks files and prerequisites, not the live agent connection.

Guided setup installs the package's matching skill by default. The skills.sh
route can select newer repository instructions, so follow actual server schemas
and the release boundary above. Static JavaScript CLI inspection can proceed
while MCP is unavailable:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

It returns the complete Evidence record directly and requires no native engine.
Provider failures in doctor do not prevent unrelated target-free tools. To check
readiness for one task instead of auditing every integration, see
[Check readiness for your task](#check-readiness-for-your-task).

## Supported agents

Setup can configure these clients for REA's local MCP server:

| Client             | `--client` value |
| ------------------ | ---------------- |
| Claude Code        | `claude_code`    |
| Claude Desktop     | `claude_desktop` |
| Codex              | `codex`          |
| Cursor             | `cursor`         |
| Gemini CLI         | `gemini_cli`     |
| Windsurf           | `windsurf`       |
| Devin              | `devin`          |
| OpenCode           | `opencode`       |
| Antigravity        | `antigravity`    |
| GitHub Copilot CLI | `copilot_cli`    |
| Command Code       | `commandcode`    |
| VS Code            | `vscode`         |
| Grok Build         | `grok_build`     |
| Grok Bot           | `grok_bot`       |

For OpenCode, setup writes the V1 `mcp.rea` entry, which OpenCode V1 and V2
both load. If the configuration already uses OpenCode V2's native
`mcp.servers` table, setup registers REA there instead and replaces any earlier
`mcp.rea` entry from REA.

Grok Build loads `[mcp_servers.rea]` from `$GROK_HOME/config.toml`, or from
`~/.grok/config.toml` when `GROK_HOME` is unset. Setup edits only that server
table and `[mcp_servers.rea.env]`, and sets `startup_timeout_sec = 30`. The
shared skill installed under `~/.agents/skills` is already on Grok Build's
skill path.

Grok Bot is detected from `~/.grokbot`, or from `SAND_DATA_ROOT` when that
value is an absolute path. Setup writes `mcpServers.rea` to `mcp.json` in that
directory. The desktop app keeps the connectors it actually runs in the
signed-in account. That file is the registration to add there; setup does not
call the account API.

## Review setup changes

`rea setup` first offers the supported agents in a multi-select. Existing REA
registrations are selected by default. Newly detected clients remain available
but unselected: detection gives setup context, not permission to add a new
registration. Clients without a detected configuration can still be selected.
Explicit `--client` flags skip this question.

Setup adds MCP access for selected clients. It installs REA's bundled workflow
with those integrations by default; use `--skill=false` to omit it. If no agent
is selected, setup offers the workflow separately for CLI use, with No as the
default. Hopper is a separate optional choice: setup shows its proposed
installation or connection and requires its own explicit approval. It can also
save verified paths for an existing Ghidra installation.

After selection, review the plan's exact paths and changes and approve before
REA writes files or installs Hopper. You can cancel at any prompt.

Before applying changes, REA checks your current configuration. The plan lists:

- an existing Hopper installation, a verified existing Ghidra installation, or the official Hopper package it proposes to install;
- each detected agent configuration path;
- the REA skill destination;
- external software, network origins, integrity evidence, and package-manager
  commands.

Malformed or unsafe existing configuration blocks the whole transaction before
Hopper installation or any file write. Declining or pressing Ctrl-C makes no
changes. Agent configuration writes preserve unrelated
entries, create backups, use atomic replacement, and verify their result.

After setup, REA reports which agents, analysis tools, and workflow files passed
its final checks. Restart any agent named in the completion message, then begin
your investigation. Failed steps and diagnostics remain in terminal history.

Select exact clients in scripts with repeatable `--client` flags. Each explicit
client skips interactive selection. Use `--all-detected` only when you intend
to configure every detected supported client. `--skill=false` omits the
workflow, and `--dry-run` returns a read-only plan with status `planned` and
exit code 0:

```bash
rea setup --client codex --client cursor --skill=false --dry-run
```

Prompt UI and progress are written to stderr so stdout remains available for
structured results and pipelines. `NO_COLOR=1` disables color. Use
`--accessible` for sequential, vertically rendered yes/no prompts. Implicit
interactive setup requires stdin, stdout, and stderr to all be terminals; when
any stream is redirected, setup stays non-interactive. Declining or cancelling
returns status `cancelled` with exit code 0.

For automation, `rea setup --json` reports the plan and a compact `.doctor`
readiness projection without applying it. Use `rea doctor --json` for full
health diagnostics and canonical tool catalog details. Pair
`--yes` with explicit scope such as `--client codex`, or use
`--all-detected` when the broad scope is intended. Without a scope flag,
`--yes` is limited to existing REA-owned registrations; it does not select all
detected clients. An unapproved actual apply reports `needs_confirmation` and
exits 1. Installing missing Hopper non-interactively additionally requires
`--install-hopper`:

```bash
rea setup --yes --all-detected --install-hopper --json
```

Setup pins package-runner MCP registrations to the exact installed REA version,
installs the matching skill and on-demand references in the same plan, and adds
`startup_timeout_sec = 30` for Codex and Grok Build. `rea update` installs the exact resolved
release into the npm prefix that owns the running package, then checks the new
executable's version before reporting success. It does not reopen onboarding.
Release lookup and installation both use npm's configured registry.
Its maintenance plan selects only existing REA registrations and an already
installed REA skill. Run the returned scoped setup command to review and approve
those changes, then restart affected agents. The plan is returned in terminal,
non-TTY, and JSON modes without applying configuration changes.

## Check readiness for your task

Run `rea doctor` when you need diagnosis. It reads host prerequisites and agent
configuration without changing them. Without options, it audits every detected
registration, the installed skill and optional analysis engines; its overall
`healthy` value can be false while your chosen workflow works.

Select the part you want to check:

| Task                                | Readiness check                                                          |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Static JavaScript/Electron analysis | Run `rea analyze-javascript-application PATH --json` directly.           |
| One analysis engine                 | `rea doctor --provider ghidra --json` (or `hopper`, `ida`)               |
| One agent registration              | `rea doctor --client codex --json` (see [client IDs](#supported-agents)) |
| Installed workflow instructions     | `rea doctor --skill --json`                                              |

A scoped report has `scope.mode: "explicit"`. Its `scope_checks` determine
`healthy` and the exit status. Other checks appear in `informational_checks`;
`environment_healthy` summarizes the full audit. `--target` adds a target check,
but the report remains audit-wide unless a scope option is also supplied.

Follow the remediation for the failed check. If a native target has several
available providers, choose one with `--provider` on the CLI or `provider_id`
on `open_binary`. A `capability_unavailable` failure carries
`details.selection_reason`: `ambiguous` asks you to choose from
`details.candidate_ids`, while `provider_unavailable` asks you to repair the
selected engine. See [provider selection](cli.md#choose-a-provider).

## Hopper

Hopper is separate commercial software with its own license. Its free demo has
vendor-defined limits, and a paid license is optional. REA reuses any detected
installation and preserves Hopper during uninstall.

The supported native host baseline is macOS 12+, Ubuntu 24.04+, Fedora 41+,
64-bit Arch Linux, or CachyOS. Ghidra and IDA have their own provider-specific
host requirements; Windows Ghidra uses the [experimental P0 boundary](windows-ghidra-p0.md).

On macOS, approved setup downloads the official DMG, checks its published size
and digest, validates the application bundle, and atomically installs it to
`~/Applications/Hopper Disassembler.app`. REA then opens Hopper so the
operator can choose its demo mode or activate an existing license. Homebrew and
administrator access are not used.

The Hopper launcher action used by REA creates a document from an executable;
its supported command-line interface does not attach to an already-open
document. While another live REA session owns the same target and loader
profile, a second session reports the owning run ID instead of opening a
duplicate document. Closing the owning REA session releases this guard; Hopper
keeps its document open. A later REA session can therefore open another
document for the same target. REA does not currently identify, focus, or reuse
that existing GUI document, and the supported launcher exposes no attach or
reuse action for it.

On supported Linux distributions, approved setup verifies Hopper's official
`.deb`, `.rpm`, or Arch package before invoking the native package manager.
REA runs the supported demo build on a private Xvfb display and selects Hopper's
offered demo mode for each analysis session; it does not require the user's
desktop display. Unattended package-manager access requires
`--yes --install-hopper`. If the host exposes `/tmp/.X11-unix` as an immutable
mount, REA first verifies the conflict and then uses an unprivileged user and
mount namespace with a private mode-1777 tmpfs over that directory only. The
host mount and the rest of `/tmp` remain unchanged; this fallback never invokes
`sudo`. `rea doctor --provider hopper --json` reports the selected
strategy and both host and effective mount facts.

### Launcher paths and troubleshooting

On macOS, REA uses
`/Applications/Hopper Disassembler.app/Contents/MacOS/hopper` by default.
On Linux, it prefers executable `/opt/hopper/bin/Hopper`, then executable
`~/.local/share/rea/hopper/bin/Hopper`; if neither exists, the former remains
the diagnostic fallback. `HOPPER_LAUNCHER_PATH` overrides those choices:

```bash
export HOPPER_LAUNCHER_PATH=/absolute/path/to/Hopper
rea doctor --provider hopper --json
```

If a Linux launcher exists but cannot start, inspect its shared libraries:

```bash
ldd /absolute/path/to/Hopper | grep 'not found'
```

Install the missing packages and rerun the scoped check. Linux demo sessions
need Xvfb, Python 3, X11 and XTEST; approved setup installs those dependencies
on supported distributions. Add the curl installer's reported executable
directory, commonly `~/.local/bin`, to your shell `PATH` if needed.

REA starts Hopper when needed. On macOS, its launcher can bring a window or
first-run dialog forward; choose demo mode or activate your existing license.
Hopper serializes analysis requests. Cancelling a wait can leave provider work
running, which the session reports. Successful decompilation is cached until
a relevant rename or comment changes it.

Closing a session shuts down REA's bridge and removes its temporary socket
directory while preserving the Hopper application. A `cleanup_incomplete`
result identifies resources whose cleanup could not be verified.

### Hopper in CI

REA's unattended Linux path is validated against Hopper's offered demo mode.
A paid license is not required for that path, and REA does not read, install, or
automate license credentials. Licensed Hopper installations remain supported,
but license activation is an operator-owned prerequisite rather than part of
REA setup.

macOS requires Hopper's first-run UI to be completed in the same user session
that will run REA: choose the demo mode or activate an existing license before
starting an unattended job. Ephemeral macOS runners therefore need a
pre-provisioned user session or a deliberate interactive bootstrap step.

When Hopper cannot start in CI, run
`rea doctor --provider hopper --json` in the failing runner.
Structured failures distinguish private-display dependencies, an unsupported
demo dialog or build, process-ownership conflicts, and an early lifecycle exit.
Apply the reported remediation rather than exposing the runner's desktop,
copying license secrets into logs, or killing unrelated Hopper processes.

## Ghidra

REA connects to an existing Ghidra installation on Linux x64, macOS x64/arm64,
or experimental Windows x64 P0.
It accepts Ghidra 12.1.x and the 64-bit full JDK declared by that installation's
`application.java.min` and `application.java.max`. Current 12.1 releases require
JDK 21 or newer and set no maximum. The bridge is verified with Ghidra 12.1.4
and JDK 21. On macOS, the installation
must include the native decompiler for the host architecture; REA does not
build it or change Gatekeeper quarantine settings.

The adapter exposes 25 read-only operations: thirteen inventory/name/search
operations and twelve function-analysis operations. These cover metadata,
decompilation, assembly, resolved calls, typed references, xrefs, function
dossiers, instructions, recovered data types, measured load mappings, loaded
memory bytes, and observed file offsets. Independent load-image attestation
supports DOS MZ and explicitly selected COM; PE returns its measurements with that limitation.
On Linux and macOS, `annotate_native_function` also edits a function name and/or
entry comments atomically and returns refreshed analysis. These session metadata
edits leave executable bytes unchanged and are discarded on close. GUI controls
require Hopper; Windows P0 remains read-only.

Windows P0 admits native x86 and x86-64 PE applications on fixed local NTFS volumes.
The npm package bundles native Job Object ownership, protected private runtime
DACLs, and handle-based path admission; no separate addon installation is needed.
See the [Windows Ghidra P0 guide](windows-ghidra-p0.md) for verified scope and
limitations.

Extract Ghidra and install the JDK outside REA, then export absolute paths:

```bash
export GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra_12.1.4_PUBLIC
export JAVA_HOME=/absolute/path/to/jdk-21 # optional if java/javac are on PATH
rea doctor --json
rea setup
```

On Windows, configure the existing installation in PowerShell:

```powershell
$env:GHIDRA_INSTALL_DIR = "C:\tools\ghidra_12.1.4_PUBLIC"
$env:JAVA_HOME = "C:\Program Files\Java\jdk-21"
rea doctor --json
rea providers --json
```

`rea setup` can configure supported Windows agents and install the bundled
REA skill after approval. Direct registrations use Node to launch REA's entry
script; package-runner registrations use the pinned `npx` command. Hopper
installation remains unavailable on Windows. Setup never installs Ghidra,
Java, or Python. It preserves valid detected Ghidra/JDK settings in agent
registrations. See [Windows Ghidra P0](windows-ghidra-p0.md) for provider diagnostics.

Doctor validates the platform, architecture, Ghidra 12.1.x application version,
`support/analyzeHeadless` or `support/analyzeHeadless.bat`, the installation's
Java major range, 64-bit JDK bitness, and the presence of `javac`/`javac.exe`.
When Java is found through `PATH`, setup records its observed JDK home so GUI
MCP clients do not depend on an incidental shell path. Setup shows every exact
environment entry in its plan, writes only after approval, and never downloads,
installs, upgrades, or modifies Ghidra or Java.

Each verified session uses an ephemeral temporary project and isolated
home/cache/config/temp paths. REA passes `-readOnly`, `-deleteProject`, uses
Ghidra's default analysis and resource settings, and loads its packaged Java
bridge via `-scriptPath`; it never opens an existing user project. Linux and
macOS use a current-user-only local bridge socket and descriptor. The
experimental Windows transport uses authenticated IPv4 loopback with a
private native-owned bearer descriptor and Job Object process ownership.

Operations begin only after default auto-analysis completes. `open_binary`
selects and validates the target/provider binding; it does not wait for Ghidra
import and auto-analysis. The first Ghidra-backed query starts that work lazily.
The provider startup deadline is 330,000 ms for import, analysis, bridge, and
health readiness; a startup failure is returned by the query that triggered it,
without exposing partial analysis. This deadline is separate from MCP transport
initialization and the client's deadline for that individual tool call. A client
can time out earlier even when Ghidra would complete within its startup deadline.
See [Ghidra first-query deadlines and recovery](mcp-contracts.md#ghidra-first-query-deadlines-and-recovery)
for client options and the close/reopen recovery flow.

One session contains exactly one imported Program; use `provider_id: "ghidra"`, `--provider ghidra`, or
`REA_ANALYSIS_PROVIDER=ghidra` when both Hopper and Ghidra support the target.
One persistent decompiler is owned by the Program, and a serial queue keeps
Ghidra API calls on the owning Program thread without a fixed queue length.
Operations run until a result, caller cancellation, or provider shutdown; there
is no fixed per-operation or response-size ceiling. Unresolved computed calls
remain unknown, reference-kind provenance is preserved, and provider-specific
pseudocode is never treated as original source or Hopper-equivalent text.

Unexpected request failures retain their original internal cause. CLI and MCP
errors expose Error names, messages, and available codes under
`details.diagnostics.failure_cause`; other rejection values retain their
primitive value or an explicit type. Shutdown warnings include the failure
kind, message, and diagnostics, while process and temporary-project cleanup
continues. These messages redact known bridge authentication tokens and
preserve local paths and other analysis context.

Run `GHIDRA_INSTALL_DIR=... npm run verify:ghidra` from a source checkout to
compile and analyze debug and stripped host-native fixtures (ELF on Linux x64
or Mach-O on macOS), plus a native DWARF 4 type-layout object. This lane needs a
host C compiler in addition to Ghidra and its JDK.

Run `GHIDRA_INSTALL_DIR=... npm run verify:ghidra:cross-format` to add AArch64
ELF, x86-64 PE, and x86-64 Mach-O fixture coverage. This separate lane needs
`clang`, LLD, and `lld-link` on `PATH`; `REA_CLANG` and `REA_LLD_LINK` select
alternate command paths. Missing cross-target tooling does not block the
host-native Ghidra acceptance lane.

On a controlled Windows x64 runner, use
`npm run verify:ghidra:windows`. The verifier generates a deterministic native
PE fixture from source bytes and requires the Windows native authority before
opening the provider. The controls are implemented on main; see the
[release boundary](#released-package-and-main). The lane verifies all 25 admitted
read-only operations, digest identity, and runtime cleanup. The separate
`verify:ghidra:windows:package` lane checks the packed CLI/MCP boundary with an
ordinary user. It requires the built Windows native bundle and an existing
Ghidra/JDK installation; neither is inferred from startup alone.

## Diagnose, update, and remove

`rea doctor --json` is strictly read-only. `rea update` updates only the npm installation that owns the running CLI. Source checkouts and package-runner copies must be updated through the mechanism that owns them; a fresh package-runner invocation can use `npx rea-agents@latest`. `rea uninstall` removes only REA-owned agent registrations and skill files; `--purge-data` additionally removes REA cache and state paths.

```bash
rea update
rea uninstall
rea uninstall --purge-data
```

Uninstall preserves Hopper, Node.js, Evidence files, captures, unrelated skills
and other MCP servers. Purging removes only REA's cache and state under
`~/.rea`; malformed client configuration or purge-path symlinks stop the
operation. See the [CLI guide](cli.md#output-and-exit-status) for exit statuses.

## MCP Registry

REA is published in the official MCP Registry as `io.github.morluto/rea`. Registry
clients can discover the server and install the existing public `rea-agents` npm
package; the Registry entry does not introduce a second distribution artifact.

For a client that supports Registry discovery, search for `io.github.morluto/rea`
and select the npm package. The published metadata launches the existing stdio
server through `npx` with the `mcp` command.

For a client that requires manual configuration, use:

<!-- x-release-please-start-version -->

```json
{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ["-y", "rea-agents@6.0.0", "mcp"]
    }
  }
}
```

<!-- x-release-please-end -->

Persistent registrations should use one exact package version. `rea setup`
writes the same package-runner shape and pins it to the exact version that
performed setup. Run current setup to refresh an older registration, then
restart the client.
