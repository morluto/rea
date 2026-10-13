# Installation and setup

Run REA, connect your selected agents, and check the tools needed for your task.
Setup previews configuration changes and asks for approval before applying them.

| Task                              | Section                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| Connect an agent                  | [Start setup](#start-setup), then [review changes](#review-setup-changes) |
| Diagnose one task                 | [Scoped readiness checks](#check-readiness-for-your-task)                 |
| Configure an analysis engine      | [Hopper](#hopper), [Ghidra](#ghidra), or the [IDA guide](ida-provider.md) |
| Update or remove REA              | [Maintenance](#diagnose-update-and-remove)                                |
| Resolve a client-specific problem | [Client configuration](client-configuration.md)                           |

## Start setup

```bash
npx rea-agents setup
```

Choose the agents to configure, review the proposed paths and changes, and
approve the plan. npm's package-download approval and REA's setup approval are
separate. Setup asks before changing agent configuration or installing Hopper.
Restart the agents named in the completion message.

For the latest published release, use `npx rea-agents@latest setup`.
[Package-runner and global-installation options](#package-runners-and-global-installation)
cover explicit versions, Bun, runtime requirements, and the curl wrapper.

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
- each selected REA skill destination;
- external software, network origins, integrity evidence, and package-manager
  commands.

Malformed or unsafe existing configuration blocks the whole transaction before
Hopper installation or any file write. Declining or pressing Ctrl-C makes no
changes. Agent configuration writes preserve unrelated entries and comments,
create backups, use atomic replacement, and verify their result. Setup and
uninstall retain an existing `.rea.backup` rather than replacing the first snapshot.
If that snapshot differs from the current configuration, setup previews and
preserves a verified `.rea.backup.<sha256>.recovery` copy of the current bytes.
Both snapshots remain available; a failed rollback reports the current recovery
copy's path and the restore failure.
Setup also retains valid environment overrides in REA's existing server entry,
such as `REA_MCP_INPUT_SCHEMA_PROFILE` and `REA_MCP_MAX_RESPONSE_BYTES`.
Detected provider settings replace only matching environment keys.
Setup and doctor report a malformed REA environment map or invalid runtime
setting before setup writes files. Repair the named setting in the client
configuration; setup does not silently discard the rest of the map.

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

### Skill destinations

The bundled skill is installed in each selected client's personal skill directory.
See [client configuration](client-configuration.md) for client-specific roots,
profiles, and environment overrides. A mixed selection plans each distinct
destination. Selecting the skill without a client uses `~/.agents/skills`.
Setup leaves existing skill copies in other locations untouched.

`rea setup --skill-client claude_code --yes --json` refreshes and verifies the
selected skill destination independently of MCP registration selection. The
final `doctor.scope.skill_clients` records which skill destinations were
checked; `doctor.scope.clients` continues to describe required registrations.
An unselected shared skill does not affect a client-only refresh.

`doctor --skill --json` verifies the selected copies against the bundled
instructions and references. Consumers should use `identity.skill.state`,
`installed_version`, and `installed_tool_count` for skill readiness. The
obsolete `installed_catalog_digest` field has been removed; current catalog
identity remains available at `identity.catalog`.

Setup pins package-runner MCP registrations to the exact installed REA version,
installs the matching skill and on-demand references in the same plan, and adds
`startup_timeout_sec = 30` for Codex and Grok Build.

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

## Diagnose, update, and remove

`rea doctor --json` is strictly read-only. `rea update` updates only the npm or Bun global installation that owns the running CLI. Source checkouts and package-runner copies must be updated through the mechanism that owns them; a fresh package-runner invocation can use `npx rea-agents@latest` or `bunx rea-agents@latest`. `rea uninstall` removes only REA-owned agent registrations and skill files; `--purge-data` additionally removes REA cache and state paths.

```bash
rea update
rea uninstall
rea uninstall --purge-data
```

Uninstall preserves Hopper, Node.js, Evidence files, captures, unrelated skills
and other MCP servers. Purging removes only REA's cache and state under
`~/.rea`. A client configuration that is malformed, unreadable, or at an unsafe
path stops the operation before anything is removed, and a client that fails
while being updated stops the remaining removals. A purge path that is a
symbolic link is retained and reported rather than followed. Uninstall checks
REA's managed shared and Claude Code personal skill locations. See the
[CLI guide](cli.md#output-and-exit-status) for exit statuses.

### Update the owning installation

`rea update` installs the exact resolved
release into the npm prefix or Bun global directory that owns the running
package, then checks the new executable's version before reporting success. It
does not reopen onboarding. For npm installations, release lookup and
installation both use npm's configured registry. Bun global updates require
Bun 1.2.17 or later, which introduced `bun info`. The updater checks `bun --version`
first and stops with an instruction to upgrade Bun manually if the version is
older or cannot be parsed; it does not upgrade Bun itself.
For supported Bun global installations, `bun info` and
`bun add --global --ignore-scripts` use Bun's configured registry
and run inside the owning Bun global directory (`BUN_INSTALL_GLOBAL_DIR`, else
`$BUN_INSTALL/install/global`, else `$XDG_CACHE_HOME/.bun/install/global`,
else `~/.bun/install/global`), never in the caller's current project. A Bun
global directory without its `package.json` is not treated as an owned
installation, because Bun would install into the nearest ancestor project
instead.
Its maintenance plan selects only existing REA registrations and an already
installed REA skill. Run the returned scoped setup command to review and approve
those changes, then restart affected agents. The plan is returned in terminal,
non-TTY, and JSON modes without applying configuration changes.

## Released package and main

Repository main documents its current code and generated catalog. `@latest`
selects the npm release, and persistent MCP registrations are pinned to the
version that performed setup. Installing newer instructions does not update a
running server or its registration.

The npm release checked on **2026-10-11** was **6.4.0**, published from
[`a56f7bb6`](https://github.com/morluto/rea/commit/a56f7bb668ab23fec8d33f7af353ac7ed2fe1895).
The actual registry package accepted dry-run setup plans for the 17 client IDs
in that release, including Qwen Code, Pi and Hermes. DeepSeek Harness (`dsh`)
is on main and is not in npm 6.4.0; `rea setup --client dsh` against `@latest`
reports an unsupported client until a release containing it is published.
OpenCode's plan selected
`OPENCODE_CONFIG_DIR` even when that directory did not yet exist. These checks
used an isolated home on macOS with Node 24; they verify planning and argument
admission, without writing client configuration or establishing live integration
with every client. This resolves the npm 6.3.0 setup gaps tracked in
[#1650](https://github.com/morluto/rea/issues/1650).

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
[conditional connection guide](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md#connect-only-when-needed).
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

Setup can configure these clients for REA's local MCP server. Grok Bot uses a manual
hosted connector; see [its configuration](client-configuration.md#other-client-settings).

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
| Qwen Code          | `qwen_code`      |
| VS Code            | `vscode`         |
| Grok Build         | `grok_build`     |
| OMP                | `omp`            |
| Pi                 | `pi`             |
| Hermes             | `hermes`         |
| Qoder              | `qoder`          |
| Trae               | `trae`           |
| ZCode              | `zcode`          |
| DeepSeek Harness   | `dsh`            |

`dsh` is main-only until a release after 6.4.0. The registry check above does
not cover it.

See [client configuration and troubleshooting](client-configuration.md) for
configuration paths, profiles, trust policies, and schema-limit workarounds.

### DeepSeek Harness

See [the Cordis patch and launcher setup](client-configuration.md#deepseek-harness).

### Other client settings

See [OpenCode, Grok Build, and Grok Bot settings](client-configuration.md#other-client-settings).

## Hopper

Hopper is separate commercial software with its own license. Its free demo has
vendor-defined limits, and a paid license is optional. REA reuses any detected
installation and preserves Hopper during uninstall.

The supported native host baseline is macOS 12+, Ubuntu 24.04+, Fedora 41+,
Nobara 44+, 64-bit Arch Linux, CachyOS, or Omarchy. Ghidra and IDA have their own provider-specific
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
duplicate document. On macOS, closing the owning REA session releases this guard;
Hopper keeps its document open. A later REA session can therefore open another
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

The supported Linux demo forwards additional launches into its existing
application, even across private displays. REA therefore reserves one Linux
Hopper application per user across cooperating REA processes. A competing
CLI or MCP session receives the owning session ID before Hopper is launched,
for both the same target and a different target. Switch targets through that
MCP session, or close it before starting another session. Closing the owner
releases the reservation and stops REA's owned demo application and private
display; the headless Linux demo does not retain documents after MCP shutdown.
Its helper watches a private lifetime pipe, so an owner crash or SIGKILL also
stops those children, without relying on a reusable PID or a process-name scan.
A later session recovers the dead owner's stale lease after child cleanup;
private runtime files can remain when REA itself was killed. This does not attach to
or claim ownership of manually opened Hopper applications. An application left
running by an older REA version must still be closed before starting a new session.

Stale lease recovery is serialized. If an interrupted recovery leaves its
reservation directory, the diagnostic identifies that exact path. Stop REA
sessions before removing that recovery directory and retrying.

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

Hopper startup allows 120,000 ms for launch, initial analysis, and authenticated
bridge readiness. For large targets, set `REA_HOPPER_STARTUP_TIMEOUT_MS` to a
decimal integer from 1 to 2,147,483,647 milliseconds in the environment that
starts REA. CLI and MCP use the same setting; invalid values fail configuration
validation. An MCP client's own request timeout must also allow enough time.

If macOS denies Apple Events, allow the application that starts REA under
**System Settings → Privacy & Security → Automation**, then retry. REA releases
the target reservation when the native helper reports its complete authorization
rejection and its arguments cannot alter the helper's generated AppleScript.
Arguments containing quotes, backslashes, or line breaks remain unchanged but
cannot establish that a failed handoff opened no document. Other failed handoffs
retain ownership until document closure is confirmed. If a timed-out bridge
becomes ready later, `close_binary` connects to that run, authenticates its
identity, and requests document shutdown. After a connection drops, the bridge
allows 30 seconds for an authenticated cleanup reconnect, then releases Hopper's
Python execution thread. Expiry does not establish document closure, so REA
retains unconfirmed ownership. Retry close while the bridge remains available.

If a Linux launcher exists but cannot start, inspect its shared libraries:

```bash
ldd /absolute/path/to/Hopper | grep 'not found'
```

Install the missing packages and rerun the scoped check. Linux demo sessions
need Xvfb, Python 3, X11 and XTEST; approved setup installs those dependencies
on supported distributions. Add the curl installer's reported executable
directory, commonly `~/.local/bin`, to your shell `PATH` if needed.

REA starts Hopper when needed. On macOS, complete its demo or license prompt in
the same user session before the first CLI/MCP operation or unattended job. Open
Hopper manually if needed; its launcher can also bring the dialog forward.
If startup reports `Cannot launch Hopper! Connection is invalid.` or waits for
bridge readiness, check Hopper for a pending demo, license, or loader dialog.
Complete the dialog and retry. If REA reports `cleanup_incomplete`, follow the
retained-resource guidance below before reopening the target.
Hopper serializes analysis requests. Cancelling a wait can leave provider work
running, which the session reports. Successful decompilation is cached until
a relevant rename or comment changes it.

Analysis and annotation calls stay bound to the active target's native Hopper
document, even when GUI focus changes or other documents have the same display
name. Use `open_binary` to change targets. Byte reads stop at a segment boundary
and return the readable prefix with `complete: false`. File-offset mapping checks
the reverse lookup and original executable bounds; synthetic external-symbol
memory has no original file offset. For FAT Mach-O, offsets refer to the original
container file. Results retain Hopper's image-relative offset, the observed slice
base, and the source executable path.
Loader selection reads the Mach-O container header, including FAT files with a
single architecture. For FAT64, REA validates the architecture table and selected
Mach-O header, prepares a private thin image, and loads it with Hopper's native
Mach-O loader. It checks the entire source's SHA-256 while copying the slice;
source identity and reported offsets still refer to the original container.
An ambiguous architecture subtype requires an explicitly extracted thin image;
REA does not guess. Configured loader arguments remain explicit overrides.
FAT64 is distinct from the CPU architecture: FAT32 containers can contain 64-bit
executable images. This preparation avoids the Raw Binary loader dialog observed
with native FAT64 loading on Hopper 6.1.0-demo.
The prepared image and its owned document close together, including on MCP exit;
if document closure is unconfirmed, REA retains the backing image and reports
`cleanup_incomplete` with its path. Ordinary documents retain their existing
MCP-exit behavior.
Startup deadlines report missing bridge readiness and preserve the launcher
outcome; a successful helper exit does not prove that a loader dialog completed.
If an owned provider process exits, request failures preserve its observed exit
code or signal and bounded output in `details.launcher`. An exit can precede
output-stream closure; `output_closed: false` keeps that uncertainty explicit.
Later requests retain the known exit instead of reducing it to socket loss.
An external GUI's helper exit does not establish that the GUI itself exited.
For cursor navigation, string decoding, symbol-name limits, and regex matching,
see [Hopper analysis behavior](native-investigation.md#hopper-analysis-behavior).

Closing or switching a target closes its bound Hopper document, shuts down REA's
bridge and removes its temporary socket directory. The macOS Hopper application
and unrelated documents remain open; the owned Linux demo application stops.
A `cleanup_incomplete`
result identifies resources whose cleanup could not be verified.
REA retains unresolved cleanup ownership and any confirmed shutdown phases.
After addressing the reported failure, retry `close_binary` on the same
connection. Unconfirmed document or process cleanup retains the target/application
lease and prevents another client from launching against that owned resource.
Once document and process closure are confirmed, the lease can be released even
if temporary-file cleanup fails. Another client can then launch, but the owning
client must finish its retained cleanup before starting again.
An unconfirmed external document can be retried while its authenticated bridge
remains connected. If that bridge has disconnected, another close cannot confirm
the document: inspect and close the reported document in Hopper before ending
the owning REA connection.

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

REA connects to an existing Ghidra installation on Linux x64/arm64, macOS x64/arm64,
or experimental Windows x64 P0.
It accepts Ghidra 12.1.x and the 64-bit full JDK declared by that installation's
`application.java.min` and `application.java.max`. Current 12.1 releases require
JDK 21 or newer and set no maximum. The bridge is verified with Ghidra 12.1.4
and JDK 21. Each installation must include the native decompiler for the host
architecture in `Ghidra/Features/Decompiler/os/<platform>/` or the corresponding
`build/os/<platform>/` directory. Linux ARM64 uses `linux_arm_64`; official
release archives may require you to build that native component separately.
REA checks the executable prerequisite by inspecting the file's own executable
header, so a native component built for another platform or architecture is
reported as incompatible instead of being admitted from its directory name, and
a header that cannot be read or recognized is reported as unknown. REA does not
build or install native tools, or change Gatekeeper quarantine settings.

The adapter exposes 25 read-only operations: thirteen inventory/name/search
operations and twelve function-analysis operations. These cover metadata,
decompilation, assembly, resolved calls, typed references, xrefs, function
dossiers, instructions, recovered data types, measured load mappings, loaded
memory bytes, and observed file offsets. Independent load-image attestation
supports DOS MZ, explicitly selected COM, and explicit raw-binary imports;
PE returns measurements with an unsupported attestation status.
On Linux and macOS, `annotate_native_function` also edits a function name and/or
entry comments atomically and returns refreshed analysis, and `set_address_name`
and `set_addresses_names` name a function entry or any other mapped address
(creating or renaming its primary label) with per-address success results. These
session metadata edits leave executable bytes unchanged and are discarded on close. GUI controls
require Hopper; Windows P0 remains read-only.

Windows P0 admits native x86 and x86-64 PE applications and DLLs on fixed local NTFS volumes.
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
script; package-runner registrations use the pinned `npx` or `bunx` command. Hopper
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
Ghidra's default analysis settings, and loads its packaged Java
bridge via `-scriptPath`; it never opens an existing user project. Linux and
macOS use a current-user-only local bridge socket and descriptor. The
project remains under the selected temporary directory. If its Unix socket
pathname would exceed the host's byte limit, REA allocates a separate owner-only
socket directory under `/tmp` and removes it on close, cancellation, or failure.
Diagnostics retain the actual endpoint and both owned directories.
On Linux and macOS, REA starts the inspected JVM directly using Ghidra's own LaunchSupport
configuration. Apple platform shell wrappers hide their environments from
ownership inspection, so retaining those wrappers would prevent verified
process-group cancellation during startup.
If ownership remains unverifiable, it reports the reason and retains the process
supervisor and private runtime instead of removing files beneath a live provider.
The experimental Windows transport uses authenticated IPv4 loopback with a
private native-owned bearer descriptor and Job Object process ownership.

Operations begin only after default auto-analysis completes. `open_binary`
selects and validates the target/provider binding; it does not wait for Ghidra
import and auto-analysis. The first Ghidra-backed query starts that work lazily.
The provider startup deadline is 330,000 ms by default for import, analysis,
bridge, and health readiness. Large binaries can need more: set
`REA_GHIDRA_STARTUP_TIMEOUT_MS` to an integer between 1 and 2,147,483,647
milliseconds in the server environment. An absent setting uses the default;
empty, invalid or out-of-range supplied values fail configuration validation.
REA parses the supplied configuration environment and
passes the deadline to each provider client; a startup failure is returned by the query that triggered it,
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

### Missing macOS native decompiler

If `rea doctor --json` reports `native_decompiler` as missing on macOS x64,
the extracted Ghidra archive may include the decompiler source without the
macOS executable. For Ghidra 12.1.4, you can build it manually with an existing
Xcode Command Line Tools installation, `make`, and `bison`:

```bash
cd "$GHIDRA_INSTALL_DIR/Ghidra/Features/Decompiler/src/decompile/cpp"
make ghidra_opt
decompiler_dir="$GHIDRA_INSTALL_DIR/Ghidra/Features/Decompiler/os/mac_x86_64"
mkdir -p "$decompiler_dir"
test ! -e "$decompiler_dir/decompile" && test ! -L "$decompiler_dir/decompile" &&
  install -m 755 ghidra_opt "$decompiler_dir/decompile"
rea doctor --json
```

The copy step requires the destination to be absent and preserves an existing
decompiler. This recipe is specific to macOS x64: the
[Ghidra 12.1.4 Makefile](https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.1.4_build/Ghidra/Features/Decompiler/src/decompile/cpp/Makefile)
explicitly selects `-arch x86_64` on Darwin. For a Gradle
build, follow the matching release's
[native component instructions](https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.1.4_build/GhidraDocs/GettingStarted.md#building-native-components).
REA accepts the matching executable under either `os/<platform>/` or
`build/os/<platform>/`; it does not build the component during setup or diagnosis.

### macOS arm64 native decompiler

On Apple Silicon the same source build works with explicit overrides; no
Makefile edits and no Rosetta are needed. The Darwin block in the
[Ghidra 12.1.4 Makefile](https://github.com/NationalSecurityAgency/ghidra/blob/Ghidra_12.1.4_build/Ghidra/Features/Decompiler/src/decompile/cpp/Makefile)
pins `-arch x86_64`, but `ARCH_TYPE` and `OSDIR` are ordinary make variables,
and command-line assignments replace them for every compile and link rule:

```bash
cd "$GHIDRA_INSTALL_DIR/Ghidra/Features/Decompiler/src/decompile/cpp"
make ghidra_opt ARCH_TYPE="-arch arm64" OSDIR=mac_arm_64
decompiler_dir="$GHIDRA_INSTALL_DIR/Ghidra/Features/Decompiler/os/mac_arm_64"
mkdir -p "$decompiler_dir"
test ! -e "$decompiler_dir/decompile" && test ! -L "$decompiler_dir/decompile" &&
  install -m 755 ghidra_opt "$decompiler_dir/decompile"
rea doctor --json
```

Verified end to end on macOS 15.6 arm64 with Apple clang 17 and the stock
bison 2.3, against Ghidra 12.1.4: the build produces a Mach-O arm64
`ghidra_opt`, the doctor check `ghidra-native_decompiler` turns healthy with
"reports mach-o arm64, which matches darwin/arm64", and `rea decompile` on an
arm64 Mach-O returns decompiled C through the headless provider. The JDK is
not needed for the make step, only for the Ghidra provider. If your toolchain
rejects the inherited `-mmacosx-version-min=10.6` flag, retry the make with
`ADDITIONAL_FLAGS="-w"`.

### Ghidra import language and analysis seeds

Ghidra detects the language from the executable header. To set it (for example, Borland C++ PE images):

```bash
export REA_GHIDRA_LANGUAGE_ID="x86:LE:32:default"
export REA_GHIDRA_COMPILER_SPEC_ID="borlandcpp"   # optional; requires a language
```

REA passes `-processor`/`-cspec`, checks both against the installation's `.ldefs`, and records them in the analysis profile. DOS imports reject an override.

To seed code that auto-analysis cannot reach (computed jumps, pointers in data):

```bash
export REA_GHIDRA_SEED_FILE=/absolute/path/to/seeds.tsv
```

Each line is `address<TAB>kind[<TAB>name]`, where kind is `function`, `code` or `label` (a label needs a name). Addresses are `0x` hex in the default space; `#` lines are comments. A pre-script applies seeds before auto-analysis: functions from the highest address down, then code, then labels. The seed digest is part of the analysis profile, and the session fails if the applied seeds differ. Result limitations report the outcome counts; a seed fails when it overlaps an instruction Ghidra already decoded.

Label seeds can name mapped uninitialized storage such as `.bss`; function and code seeds require initialized bytes.

To skip a named Ghidra auto-analyzer (for example, when default auto-analysis
stalls in one analyzer on a Swift/Objective-C arm64 Mach-O):

```bash
export REA_GHIDRA_DISABLED_ANALYZERS="Objective-C Message Analyzer"
```

The value is a comma-separated list of exact Ghidra analyzer names. A pre-script
disables each name before auto-analysis, the analysis profile records the
override in `analyzer_preset` (for example
`ghidra-default+disabled:Objective-C Message Analyzer`), and a session fails to
open when its committed profile and the setting differ. A name starts with a
letter or digit and contains only letters, digits, spaces, periods, underscores,
and hyphens; at most 32 names are admitted, each at most 120 characters.
Names must identify analyzers registered for the selected program. Unknown names
or options that remain enabled abort the headless import before auto-analysis
and the bridge, so an unsuccessful override cannot produce a session claiming
that the analyzer was disabled. For Windows PE resource analysis, the exact name
is `WindowsResourceReference`. Disabling an analyzer skips the facts it would
have produced.

### Ghidra heap and CPU controls

Set resource controls in the environment that launches the CLI or MCP server,
before opening a new Ghidra session. On Linux and macOS, REA chooses the first
nonempty setting in this order: `GHIDRA_HEADLESS_MAXMEM`, `GHIDRA_MAXMEM`, then
`2G`. The chosen value becomes the JVM's `-Xmx` argument. Use a JVM heap-size
value such as `512M` or `2G`; an invalid value causes Java startup to fail.
The supported Ghidra 12.1.4 Windows headless script consumes the same settings
with the same precedence.

For a small target on a constrained host:

```bash
export GHIDRA_HEADLESS_MAXMEM=512M
```

In PowerShell:

```powershell
$env:GHIDRA_HEADLESS_MAXMEM = "512M"
```

An MCP client must pass this setting to its REA server process; changing an
unrelated terminal's environment does not reconfigure an existing server or
JVM. A 512 MiB heap was verified with small native fixtures, but larger targets
can require more memory. The Java heap limit does not bound JVM RSS, Node's
heap, or total memory used by the process family. The startup deadline controls
waiting time independently of these memory settings.

REA clears `_JAVA_OPTIONS`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS`, and
`GHIDRA_JAVA_OPTIONS` inherited from the caller, and owns
`GHIDRA_HEADLESS_JAVA_OPTIONS`. Custom flags injected through these variables
are not supported configuration. On Windows, REA replaces `JDK_JAVA_OPTIONS`
with its own isolated home/temp settings and `-XX:-UsePerfData`; on Linux and
macOS it supplies isolated paths directly to Java. Use the supported heap
settings above instead of adding a second `-Xmx` through an injection variable.

The Linux/macOS launch sets `-XX:ParallelGCThreads=2` and
`-XX:CICompilerCount=2`; the supported Windows headless script also sets these
counts. These constrain particular JVM thread pools, not all analysis threads
or CPU usage. REA does not pass Ghidra's `-max-cpu` option or expose a general
Ghidra CPU limit. When needed, apply host CPU affinity and scheduling controls
to the REA process and verify the resulting JVM's affinity. Select CPUs allowed
on the host; do not assume CPU numbers from another machine are valid.

Verify controls at their consumer after the first Ghidra-backed query starts
the JVM: inspect that owned JVM's effective `-Xmx` and GC/compiler flags, CPU
affinity, and observed memory use. Do not infer them from the parent shell's
environment or the absence of an error. On Linux, `/proc/<jvm-pid>/cmdline`
contains the launch arguments and `/proc/<jvm-pid>/status` reports
`Cpus_allowed_list` and `VmRSS`. Inspect only the process belonging to this
session and retain the resource flags needed for the measurement rather than
copying full command lines or environments into reports. Heap and affinity
settings affect cost and latency; they are not part of REA's semantic analysis
profile identity. See [real-provider testing](testing.md) for bounded
verification workflows.

### Ghidra diagnostics and verification

Unexpected request failures retain their original internal cause. CLI and MCP
errors expose Error names, messages, and available codes under
`details.diagnostics.failure_cause`, including bounded nested causes and explicit
truncation markers. Darwin ownership-helper compilation failures also retain
the compiler outcome, exit code or signal, and bounded stderr; a timed-out
compiler remains distinguishable from a compiler that exited with an error.
Other rejection values retain their primitive value or an explicit type.
Shutdown warnings include the failure
kind, message, and diagnostics, while process and temporary-project cleanup
continues. These messages redact known bridge authentication tokens and
preserve local paths and other analysis context.

Run `GHIDRA_INSTALL_DIR=... npm run verify:ghidra` from a source checkout to
compile and analyze debug and stripped host-native fixtures (ELF on Linux x64/arm64
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

## Agent plugins and marketplaces

The repository root is both a Claude Code plugin
(`.claude-plugin/plugin.json`) and a Codex plugin
(`.codex-plugin/plugin.json`). Each manifest bundles the
`reverse-engineer-anything` skill from `.agents/skills/` and registers the
stdio server through `npx`, pinned to the exact package version in that
manifest, without a second distribution artifact.

The repository is also its own single-plugin marketplace, through
`.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json`.

In Claude Code:

```text
/plugin marketplace add morluto/rea
/plugin install rea@rea
```

In Codex, add the marketplace and then install REA from the plugin list:

```bash
codex plugin marketplace add morluto/rea
```

The repository root is also a Cursor plugin (`.cursor-plugin/plugin.json`).
It registers the same pinned stdio server from `.cursor-plugin/mcp.json` and
does not bundle the skill: Cursor loads plugin skills from a directory of
skill folders, and `.agents/skills/` also holds maintainer-only skills. Run
`rea setup --client cursor` instead when you want the workflow instructions
installed with the server.

Each release updates both manifest versions and their pinned server version
together, which is when installed copies refresh the bundled skill and move to
the new server. A plugin does not run `rea setup`, so provider
configuration still follows the sections above. Use the plugin or a
`rea setup` registration for a client, not both, to avoid two `rea` servers.

`rea doctor` does not see plugin-owned state. Its client and skill checks read
only the registrations and skill locations that `rea setup` manages, so for a
plugin-only install `rea doctor --client <id>` and `rea doctor --skill` report
`missing` and recommend `rea setup`. Do not follow that remediation. Check the
plugin with the client instead (`claude plugin list` and `/mcp` in Claude
Code, `codex plugin list` in Codex). A plugin does not put `rea` on your
`PATH`, so check analysis engines through the package runner, at the version
the plugin pins so the report describes the server it starts:

<!-- x-release-please-start-version -->

```bash
npx -y rea-agents@6.4.0 doctor --provider ghidra --json
```

<!-- x-release-please-end -->

If your installed plugin is older, use the version in its manifest instead.

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
      "args": ["-y", "rea-agents@6.4.0", "mcp"]
    }
  }
}
```

<!-- x-release-please-end -->

Persistent registrations should use one exact package version. `rea setup`
writes the same package-runner shape, or `bunx rea-agents@<version> mcp` when
setup runs through `bunx`, and pins it to the exact version that performed
setup. Run current setup to refresh an older registration, then restart the
client.

## Package runners and global installation

A package-runner invocation can use a REA version installed in the current project. To
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

With Bun, `bunx rea-agents setup` (or `bunx rea-agents@latest setup`) is the
equivalent entry point. Setup run through `npx` registers
`npx -y rea-agents@<version> mcp`; setup run through `bunx` or `bun x` registers
`bunx rea-agents@<version> mcp`. On Windows, setup wraps either command in
`cmd.exe /d /c` so clients can start the runner's command shim. Neither
registration points into the runner's temporary package cache.

REA supports Node.js 22.x (>=22.19), 24.x (>=24.11), and 26+. Node.js 23, 25, and prereleases are unsupported. It uses the npm already paired with that runtime and never upgrades Node.js, npm, or Homebrew.

When REA runs on Bun, the `rea doctor` `node` check reports the Bun version and
the Node.js compatibility version Bun declares, and passes when that
compatibility version is in the supported range. Bun does not enforce the V8
heap flags REA gives its owned helper processes, so Evidence that reports those
limits on Node.js records them as unavailable under Bun. On Windows, the owned
Job Object of each JavaScript helper (source analyzer, source-map codec and HAR
decoder) instead limits its committed memory to that helper's heap budget plus
a 512 MiB reserve for Bun itself, and Evidence reports that limit. This needs
the matching bundled Windows native artifact; an artifact without the control
refuses to start the helper rather than running it unlimited. CI tests Node.js
only.

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
