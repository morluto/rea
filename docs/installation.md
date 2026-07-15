# Installation and setup

REA separates installing its CLI from configuring external software and agents.

## Install the CLI

The recommended installation is:

```bash
npm install --global rea-agents
rea setup
```

REA supports Node.js 22.19+ and 24.11+ (including newer releases). It uses the npm already paired with that runtime and never upgrades Node.js, npm, or Homebrew.

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

`rea setup` discovers the current state, prints one plan, and asks `Continue? [Y/n]`. The plan identifies:

- an existing Hopper installation, a validated bring-your-own Ghidra environment, or the official Hopper package it proposes to install;
- each detected agent configuration path;
- the REA skill destination;
- external software and package-manager effects.

Declining makes no changes. Agent configuration writes preserve unrelated entries, create backups, use atomic replacement, and verify their result.

For automation, `rea setup --json` reports the plan without applying it. `rea setup --yes` applies user-owned registrations and the skill. Installing missing Hopper non-interactively additionally requires `--install-hopper`:

```bash
rea setup --yes --install-hopper --json
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

REA's initial Ghidra provider layer is bring-your-own and currently supports
Linux x64 with the exact official Ghidra 12.1.2 release and a 64-bit full JDK 21. It supplies discovery, analysis-profile commitment, and an isolated
read-only headless session; it intentionally declares no binary-analysis
operations yet.

Extract Ghidra and install the JDK outside REA, then export absolute paths:

```bash
export GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra_12.1.2_PUBLIC
export JAVA_HOME=/absolute/path/to/jdk-21 # optional if java/javac are on PATH
rea doctor --json
rea setup
```

Doctor validates the platform, architecture, application version,
`support/analyzeHeadless`, Java version/bitness, and the presence of `javac`.
When Java is found through `PATH`, setup records its observed JDK home so GUI
MCP clients do not depend on an incidental shell path. Setup shows every exact
environment entry in its plan, writes only after approval, and never downloads,
installs, upgrades, or modifies Ghidra or Java.

Each verified session uses a private temporary project and isolated
home/cache/config/temp paths. REA passes `-readOnly`, `-deleteProject`, a
per-file analysis timeout, CPU and heap bounds, and its packaged Java bridge via
`-scriptPath`; it never opens an existing user project. The local bridge socket
and descriptor are current-user-only, and all owned runtime paths and processes
are removed on every terminal lifecycle path.

## Diagnose, update, and remove

`rea doctor --json` is strictly read-only. `rea upgrade` updates only the npm installation that owns the running CLI. `rea uninstall` removes only REA-owned agent registrations and skill files; `--purge-data` additionally removes REA cache and state paths.
