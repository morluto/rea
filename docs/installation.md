# Installation and setup

REA separates installing its CLI from configuring external software and agents.

## Start setup

The recommended setup entrypoint is:

```bash
npx rea-agents setup
```

If npm asks to download and run the package, that approval applies only to the
current package-runner invocation. REA still prints its own setup plan and asks
for separate approval before changing agent configuration or installing a
product-owned component.

REA supports Node.js 22.19+ and 24.11+ (including newer releases). It uses the npm already paired with that runtime and never upgrades Node.js, npm, or Homebrew.

Running `npm install rea-agents` without `--global` installs the executable only
in the current project's `node_modules/.bin`; it does not make `rea` available
on the shell `PATH`. Use `npx rea-agents setup` for the guided setup journey,
`npx -y rea-agents@latest` for unattended one-off commands, or install globally
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

## Review setup changes

`rea setup` uses an inline, scroll-preserving journey inspired by the clarity of
PostHog's CLI wizard. It begins with the outcome instead of the installer
mechanics:

- investigate local applications from a supported agent;
- recover evidence through an available deep-analysis provider;
- use the bundled skill for a repeatable investigation workflow.

REA then summarizes the detected clients and presents one gateway:

- **Set up all available capabilities (recommended)** selects the complete
  resolved plan;
- **Customize** opens the concrete action picker;
- **No thanks** exits without making changes.

The custom picker labels each target by its role: `MCP` for an agent
registration, `provider` for Hopper or a validated bring-your-own provider, and
`skill` for the REA investigation skill. These labels describe different setup
modalities rather than suggesting that every target is an MCP registration.
The picker keeps its navigation, selection, confirmation, and cancellation keys
visible instead of relying on a transient hint.

Both recommended and custom paths converge on the same exact preflight. REA
validates the current state, prints the proposed effects, and asks for final
approval with **No** as the default. Selection alone never authorizes a
mutation. The plan identifies:

- an existing Hopper installation, a validated bring-your-own Ghidra environment, or the official Hopper package it proposes to install;
- each detected agent configuration path;
- the REA skill destination;
- external software, network origins, integrity evidence, and package-manager
  commands.

Malformed or unsafe existing configuration blocks the whole transaction before
Hopper installation or any file write. Declining, pressing Ctrl-C, or selecting
nothing makes no changes. Agent configuration writes preserve unrelated
entries, create backups, use atomic replacement, and verify their result.

Progress remains append-only so completed and failed operations stay visible in
terminal history. After a successful run, the completion message names the
verified capabilities now available—for example configured MCP clients, the
selected analysis provider, and the installed skill—and gives the corresponding
next action. When an agent must restart to load its registration, REA says so;
otherwise it suggests beginning an investigation. It does not advertise a
capability that the final diagnostic check did not verify.

Select exact clients in scripts with repeatable `--client` flags, or retain
automatic discovery explicitly with `--all-detected`. Use `--skill=false` to
omit the bundled skill and `--dry-run` for a read-only plan:

```bash
rea setup --client codex --client cursor --skill=false --dry-run
```

Prompt UI and progress are written to stderr so stdout remains available for
structured results and pipelines. `NO_COLOR=1` disables color. Use
`--accessible` for sequential, vertically rendered yes/no prompts.

For automation, `rea setup --json` reports the plan without applying it.
Prefer pairing `--yes` with explicit scope such as `--client codex`,
`--all-detected`, or `--skill`. Legacy unscoped `--yes` remains compatible for
this release but emits a deprecation warning. Installing missing Hopper
non-interactively additionally requires `--install-hopper`:

```bash
rea setup --yes --all-detected --install-hopper --json
```

## Hopper

Hopper is separate commercial software with its own license. Its free demo has
vendor-defined limits, and a paid license is optional. REA reuses any detected
installation and preserves Hopper during uninstall.

On macOS, approved setup downloads the official DMG, checks its published size
and digest, validates the application bundle, and atomically installs it to
`~/Applications/Hopper Disassembler.app`. REA then opens Hopper so the
operator can choose its demo mode or activate an existing license. Homebrew and
administrator access are not used.

On supported Linux distributions, approved setup verifies Hopper's official
`.deb`, `.rpm`, or Arch package before invoking the native package manager.
REA runs the supported demo build on a private Xvfb display and selects Hopper's
offered demo mode for each analysis session; it does not require the user's
desktop display. Unattended package-manager access requires
`--yes --install-hopper`.

## Ghidra

REA's Ghidra provider is bring-your-own and supports Linux x64 with the exact
official Ghidra 12.1.2 release and a 64-bit full JDK 21. An experimental
Windows x64 P0 supports approved native x86-64 PE applications. It supplies
discovery, analysis-profile commitment, an isolated read-only headless session,
ten bounded inventory/name/search operations, and eight function-analysis
operations covering metadata, decompilation, assembly, resolved calls, typed
references, xrefs, CFG, and dossiers. GUI state and analysis mutations remain
unavailable through Ghidra.

Extract Ghidra and install the JDK outside REA, then export absolute paths:

```bash
export GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra_12.1.2_PUBLIC
export JAVA_HOME=/absolute/path/to/jdk-21 # optional if java/javac are on PATH
rea doctor --json
rea setup
```

PowerShell configuration for Windows uses the same non-secret paths:

```powershell
$env:GHIDRA_INSTALL_DIR = "C:\tools\ghidra_12.1.2_PUBLIC"
$env:JAVA_HOME = "C:\Program Files\Java\jdk-21"
rea doctor --json
rea providers --json
```

`rea setup` does not mutate Windows client configuration or install Hopper,
Ghidra, Java, Python, or another package. Register the built `rea mcp` command
manually in the intended client and preserve the two environment variables.
See [Windows Ghidra P0](windows-ghidra-p0.md) for a complete example.

Doctor validates the platform, architecture, application version,
`support/analyzeHeadless` or `support/analyzeHeadless.bat`, Java
version/bitness, and the presence of `javac`/`javac.exe`.
When Java is found through `PATH`, setup records its observed JDK home so GUI
MCP clients do not depend on an incidental shell path. Setup shows every exact
environment entry in its plan, writes only after approval, and never downloads,
installs, upgrades, or modifies Ghidra or Java.

Each verified session uses an ephemeral temporary project and isolated
home/cache/config/temp paths. REA passes `-readOnly`, `-deleteProject`, a
per-file analysis timeout, CPU and heap bounds, and its packaged Java bridge via
`-scriptPath`; it never opens an existing user project. Linux uses a
current-user-only local bridge socket and descriptor. Windows P0 uses
token-authenticated IPv4 loopback, a token-free endpoint record, and bounded
process-tree termination. It does not yet prove private DACL,
reparse-point-safe, or Job Object semantics; use only approved non-sensitive
fixtures.

Operations begin only after default auto-analysis completes. A timeout fails
the open rather than exposing partial analysis. One session contains exactly
one imported Program; use `provider_id: "ghidra"`, `--provider ghidra`, or
`REA_ANALYSIS_PROVIDER=ghidra` when both Hopper and Ghidra support the target.
One persistent decompiler is owned by the Program, Ghidra API calls cross a
bounded 32-request serial queue, and each native decompile is limited to 30
seconds. Unresolved computed calls remain unknown, reference-kind provenance is
preserved, and provider-specific pseudocode is never treated as original source
or Hopper-equivalent text.

Run `GHIDRA_INSTALL_DIR=... npm run verify:ghidra` from a source checkout to
compile and analyze source-owned x86-64 debug/stripped ELF, AArch64 ELF,
x86-64 PE, and x86-64 Mach-O conformance fixtures. The verifier expects `cc`,
`clang`, and `lld-link` on `PATH`; `REA_CC`, `REA_CLANG`, and `REA_LLD_LINK` can
select alternate command paths.

On a controlled Windows x64 runner, use
`npm run verify:ghidra:windows`. The verifier generates a deterministic native
PE fixture from source bytes, exercises every admitted Ghidra operation, checks
target/snapshot/import digest identity, and requires complete runtime cleanup.

## Diagnose, update, and remove

`rea doctor --json` is strictly read-only. `rea upgrade` updates only the npm installation that owns the running CLI. `rea uninstall` removes only REA-owned agent registrations and skill files; `--purge-data` additionally removes REA cache and state paths.
