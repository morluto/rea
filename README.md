<div align="center">

**English** · [简体中文](README_zh.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [العربية](README_ar.md)

# REA: Reverse Engineer Anything

### One MCP for reverse engineering across binaries, applications, and runtime behavior.

**See a feature you like. Understand how it works, down to the binary level.**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![CI](https://img.shields.io/github/actions/workflow/status/morluto/rea/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/morluto/rea/actions/workflows/ci.yml)
[![MCP tool catalog](https://img.shields.io/badge/MCP-tool_catalog-5c4ee5?style=flat-square)](#tool-catalog-for-investigation)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22.19%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)
[![Discord](https://img.shields.io/discord/1556595354999332884?logo=discord&logoColor=white&label=Discord&color=5865F2)](https://discord.gg/GkcryMnJDM)

<a href="https://trendshift.io/repositories/82054?utm_source=repository-badge&amp;utm_medium=badge&amp;utm_campaign=badge-repository-82054" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/repositories/82054" alt="morluto%2Frea | Trendshift" width="250" height="55"/></a>

**[Website](https://morluto.github.io/rea/) · [Guides](https://morluto.github.io/rea/guides/) · [Showcases](https://morluto.github.io/rea/showcase/)**

[Quick start](#quick-start) · [Current status](#current-status) · [Investigation model](#the-investigation-model) · [Tool catalog](#tool-catalog-for-investigation) · [Roadmap](#roadmap) · [How it works](#how-it-works)

<code>npx rea-agents setup</code>

<br />

<img src="docs/assets/rea-hopper-analysis.png" alt="REA launching its analysis bridge inside Hopper while inspecting a native binary" width="1200" />

<br />

<table aria-label="REA community">
<tr>
<td align="center" width="360">
  <a href="https://discord.gg/GkcryMnJDM">
    <img src="docs/assets/discord.svg" height="42" alt="Discord" /><br />
    <strong>Join the Reverse Engineering Community</strong>
  </a><br />
  <sub>Discord · Q&amp;A · Show and Tell</sub>
</td>
</tr>
</table>

<br />

</div>

---

See a feature in an app that you want in your own product? Ask your agent to investigate it with REA. It can inspect the app without its source code, explain how the feature works, show the evidence, and build a version for your project.

REA connects your agent to tools for inspecting native binaries, JavaScript and Electron apps, .NET assemblies, and websites. You can also use the same tools from your terminal. Analysis runs locally, and results include the evidence and limitations behind each conclusion.

Setup registers REA with your agent and installs matching workflow instructions. Native analysis can use an existing Hopper or Ghidra installation; setup can optionally install Hopper with approval. Static JavaScript analysis needs neither engine.

## Quick start

### Run setup (recommended)

Set up REA with your agent:

```bash
npx rea-agents setup
```

Choose which supported agents should use REA, then review the exact paths and changes before approving. Existing REA registrations are selected by default; newly detected agents are available to select, but detection alone does not select them. Setup adds MCP access and REA's guided workflow for selected agents. Hopper is a separate optional choice with its own consent. Setup can also record an existing Ghidra installation.

Setup shows its changes before applying them and backs up existing configuration. See [Installation and setup](docs/installation.md) for requirements and setup options.

### AI Coding Assistants (optional)

Add the skill to your AI coding assistant for richer context:

```bash
npx skills add morluto/rea --skill reverse-engineer-anything
```

The skill provides REA's investigation workflow. Run setup above to connect REA to your agent and configure analysis tools. Setup already installs a version-matched skill by default; this command installs the repository version.

### With an agent (recommended)

After setup, restart your agent and [describe the app or feature](#just-ask-your-agent) you want to understand. Hopper can run in demo mode; if it shows a first-run prompt, choose the demo or enter an existing license.

REA supports Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, Windsurf, Devin, OpenCode, Antigravity, GitHub Copilot CLI, Command Code, and VS Code. Existing REA registrations are selected by default during setup; other detected agents remain unselected until chosen. Other agents can use the [manual MCP configuration](#manual-mcp-configuration).

### First result from the terminal

For your extracted JavaScript/Electron application tree or ASAR, run:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Replace the path with your target (for example, `"D:/apps/example"` on Windows).
This returns inline Evidence, recovered graph, limitations, and unknowns without
MCP setup, Hopper, Ghidra, or executing the application. For a native app, configure
its engine first, then use `analyze` with that app's path. Run `doctor` when you
need diagnosis; it is not a prerequisite for each analysis.

### Check readiness for the task at hand

`rea doctor` without options is an audit of the whole integration. It checks
every detected agent registration, the installed skill, and every optional
analysis engine, so it can report `healthy: false` while your current task works.
Choose a readiness scope for the work you are doing:

| Task                                | Readiness check                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------- |
| Static JavaScript/Electron analysis | None. Run `analyze-javascript-application` directly.                                         |
| Troubleshoot one analysis engine    | `rea doctor --provider ghidra --json` (or `hopper`, `ida`)                                   |
| Check one agent's MCP registration  | `rea doctor --client codex --json` (see [client IDs](docs/installation.md#supported-agents)) |
| Check the installed skill           | `rea doctor --skill --json`                                                                  |

A scoped report has `scope.mode: "explicit"`. Only `scope_checks` determine
`healthy` and the exit status. Everything else is listed in
`informational_checks`; you don't need to fix it for this task. For example, a
missing engine you are not using needs no repair. `environment_healthy` still
summarizes the full audit. `--target` adds a target check, but without a scope
option the report remains audit-wide.

When more than one installed engine supports a native target, REA does not pick
one: opening the target fails with `code: "capability_unavailable"`,
`details.selection_reason: "ambiguous"`, and the providers in
`details.candidate_ids`. Choose one once: pass `--provider` on
the CLI or `provider_id` on `open_binary`, or set `REA_ANALYSIS_PROVIDER` as a
standing preference. An explicit selector overrides the environment variable.
The session keeps that choice and never falls back to another engine.
Recovery depends on `details.selection_reason`. For `ambiguous`, choose one of
the candidates. For `provider_unavailable`, the engine you selected needs repair,
so run `rea doctor --provider <id> --json` and follow its remediation. Neither
reason means you have to install every engine. See
[Choosing a deep-analysis provider](#choosing-a-deep-analysis-provider).

### Install the rea command

Install the command-line interface:

```bash
curl -fsSL https://raw.githubusercontent.com/morluto/rea/main/install.sh | bash
```

The installer adds `rea` to your system and starts setup when run in a terminal. It requires Node.js and npm to be installed already.

Alternatively, install with npm, then run setup:

```bash
npm install --global rea-agents
rea setup
```

Update either installation with `rea update`.

### Requirements

Static JavaScript inspection requires the Node/npm runtime only. Host and
external-tool prerequisites depend on the selected workflow; the native
provider guides describe their supported platforms.

- macOS 12 or newer
- Ubuntu 24.04+, Fedora 41+, 64-bit Arch Linux, or CachyOS
- Node.js 22.x (>=22.19), 24.x (>=24.11), or 26+
- npm; REA does not require or install a particular npm version

Deep native binary analysis requires [Hopper](https://www.hopperapp.com/), [Ghidra](#ghidra-analysis-provider), or [IDA Pro](#ida-pro-analysis-provider). Hopper is separate software with its own license; its demo supports analysis with vendor-defined limits. Ghidra and IDA are bring-your-own providers.

Firmware region inspection and explicit extraction use caller-supplied Binwalk and Unblob on Linux. See [Firmware analysis](docs/firmware-analysis.md) for setup, provenance, resource limits and native handoff.

Static APK analysis uses a separately supplied headless JADX JAR and a full JDK, with no emulator or APK execution. See [Android analysis](docs/android-analysis.md) for setup, CLI/MCP operations, coverage and public test fixtures. Authenticated IPA and macOS `.app`, ZIP, or DMG inventory Evidence can be projected into bundle anatomy, such as XPC services, app extensions, login items, privileged helpers, and launchd plists, with [Apple application analysis](docs/apple-application-analysis.md).

Repository main and npm 4.1.0 include experimental Windows x64 Ghidra support for native x86-64 PE applications on local NTFS, with bundled Job Object, private-DACL, and path-admission controls. Check the [release boundary](docs/installation.md#released-package-and-main) before expecting this from an older npm package. See [Windows Ghidra P0](docs/windows-ghidra-p0.md) for prerequisites and verified scope.

If something is not working, run:

```bash
npx -y rea-agents@latest doctor
```

`doctor` checks your host, dependencies, analysis tools, and agent configuration without changing them. Use `--json` for structured diagnostics.

### Linux installation and troubleshooting

On macOS, setup can install Hopper in `~/Applications` after approval. It verifies the official download and does not need Homebrew or administrator privileges.

On supported Linux distributions, setup can install Hopper and its demo-session dependencies through your system package manager. You may see a system authorization prompt. Demo sessions use a private virtual display, leaving your desktop alone. See [Hopper installation](docs/installation.md#hopper) for download verification and platform details.

REA prefers an executable `/opt/hopper/bin/Hopper` on Linux. If it is unavailable, REA automatically checks `~/.local/share/rea/hopper/bin/Hopper`. If Hopper was installed elsewhere:

```bash
export HOPPER_LAUNCHER_PATH=/absolute/path/to/Hopper
rea doctor --json
```

If doctor reports a missing analysis engine even though the file exists, inspect shared-library resolution with:

```bash
ldd /absolute/path/to/Hopper | grep 'not found'
```

Install the missing packages and rerun `rea setup`. The Linux demo needs Xvfb, Python 3, X11, and XTEST; approved setup installs these dependencies. If you use the curl installer, add `~/.local/bin` to your shell `PATH` when needed.

REA uses `/Applications/Hopper Disassembler.app/Contents/MacOS/hopper` by default on macOS. On Linux it prefers executable `/opt/hopper/bin/Hopper`, then executable `~/.local/share/rea/hopper/bin/Hopper`, and keeps `/opt/hopper/bin/Hopper` as the diagnostic fallback if neither exists. Explicit `HOPPER_LAUNCHER_PATH` configuration always takes precedence.

### Ghidra analysis provider

Already use Ghidra? REA can connect it to your agent on Linux x64 or macOS x64/arm64. It accepts **Ghidra 12.1.x** and the **64-bit full JDK** that installation declares (`application.java.min` through `application.java.max`). Current 12.1 releases require JDK 21 or newer and set no maximum. The bridge is verified with Ghidra 12.1.4 and JDK 21. On macOS, your Ghidra installation must also include the native decompiler for your architecture.

Set the installation paths, then run setup:

```bash
export GHIDRA_INSTALL_DIR=/absolute/path/to/ghidra_12.1.4_PUBLIC
export JAVA_HOME=/absolute/path/to/jdk-21 # optional when java and javac resolve from PATH
rea doctor --json
rea setup
rea providers --json
```

Setup checks the installations and saves their paths in your selected agents' configuration after approval. Ghidra and Java must already be installed; REA does not download or change them.

The adapter exposes inventory, function, memory and load-image inspection, plus atomic function annotation edits on Linux and macOS. `annotate_native_function` edits names and entry comments in the session database and returns a refreshed function dossier; executable bytes stay unchanged. Ghidra does not provide GUI controls through REA.

Opening a Ghidra target selects its provider; the first analysis query starts import and auto-analysis. That query can take longer than a client's default request deadline. See [first-query deadlines and recovery](docs/mcp-contracts.md#ghidra-first-query-deadlines-and-recovery) for an SDK example and cancellation recovery.

REA analyzes a temporary copy of the target and removes the temporary project when the session closes. Results identify what Ghidra observed and what it could not resolve. Decompilation produces pseudocode rather than the original source.

Ghidra also imports DOS MZ executables with an explicit 16-bit x86 real-mode profile. Function results include complete observed body ranges, distinguishing owned bytes from the enclosing span. See the [DOS analysis guide](docs/ghidra-dos.md) for addresses, packing, and verification boundaries.
See [optional NativeAOT metadata recovery](docs/ghidra-nativeaot.md) for the pinned
headless adapter, supported layout and existing native-tool workflow.

Windows Ghidra P0 uses bundled native controls for its read-only native x86-64 PE boundary on local NTFS; see the [Windows Ghidra P0 guide](docs/windows-ghidra-p0.md). See [Ghidra installation](docs/installation.md#ghidra), [provider evaluation](docs/provider-evaluation.md), and [testing](docs/testing.md) for configuration details, coverage, and real-provider verification.

To remove only REA-owned MCP registrations and the managed skill:

```bash
rea uninstall
rea uninstall --purge-data # also removes only ~/.rea/cache and ~/.rea/state
```

Uninstall preserves Hopper, Node.js, Evidence files, captures, unrelated skills, and other MCP servers. It refuses malformed client configuration and never follows purge-data symlinks.

### IDA Pro analysis provider

Already have [mrexodia/ida-pro-mcp](https://github.com/mrexodia/ida-pro-mcp) working? REA can reuse its MCP registration for read-only analysis of the current GUI target, or use its database supervisor to open and analyze a supplied binary headlessly.

```bash
export REA_IDA_MCP_CONFIG=/absolute/path/to/ida-mcp.json
rea function /absolute/path/to/program main --provider ida --json
```

The registration selects `attached` (default, legacy 1.4 tools) or `headless` (modern database supervisor). Setup can preserve this file reference in your selected agent's REA registration. REA adapts existing analysis contracts and manages its own headless database; it leaves an attached GUI database open and never saves it. Results stay live because external IDA database changes are not immutable snapshots.

See the [IDA provider guide](docs/ida-provider.md) for upstream installation links, exact configuration examples, Windows-native headless operation, lifecycle cleanup, and coverage. The initial real workflows cover a Windows GUI and Windows x64 headless IDA 9.3; other engine/platform combinations remain unverified. Use a package version that includes this adapter; repository main can lead the npm release.

### CLI or agent?

| If you want to…                                                  | Use                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------- |
| Ask an agent to investigate an app and build a feature           | Run setup, restart your agent, then describe the task               |
| Inspect or decompile one part of an app from the Terminal        | `rea analyze` or `rea decompile`                                    |
| Validate, canonicalize, or compare Evidence bundles              | `rea evidence-import`, `rea evidence-export`, or `rea compare`      |
| Map a local JavaScript/Electron application without executing it | `rea analyze PATH` or `rea analyze-javascript-application`          |
| Reuse immutable analysis results without relaunching a provider  | Pass `--snapshot /path/to/analysis.json` to a deep-analysis command |
| Import source as historical reference                            | `rea import-reference-source`                                       |
| Capture or compare controlled process behavior                   | `rea capture-process` or `rea compare-process-captures`             |

```bash
rea evidence-import /absolute/path/to/evidence/bundle.json
rea evidence-export /absolute/path/to/evidence/bundle.json /absolute/path/to/evidence/canonical.json
rea compare /absolute/path/to/evidence/left.json /absolute/path/to/evidence/right.json
```

Analyze a JavaScript application directory or ASAR without executing it:

```bash
rea analyze /absolute/path/to/releases/app.asar --json
rea analyze-javascript-application /absolute/path/to/releases/app.asar --json
```

For a directory or `.asar`, generic `rea analyze` automatically selects the
static JavaScript application provider when neither `--provider` nor
`--snapshot` is supplied. Both routes return the analysis and its Evidence
context inline.

Import an older source tree as a reference. REA keeps it separate from observations of the current app:

```bash
rea import-reference-source /absolute/path/to/source
```

Historical-source import requires safe no-follow file opens and currently runs
on Linux and macOS. Native Windows reports `unsupported_host`; run the import
with Linux REA in WSL or on another supported host. Changing permissions or
reinstalling REA does not enable this Windows workflow.

Imports read the path supplied to the command. File names do not cause automatic omissions; files are represented by hashes and metadata. To exclude selected paths, set `REA_REFERENCE_SECRET_PATTERNS_JSON` to a JSON string array of ignore patterns. Exports never replace an existing file unless `--overwrite` is explicit.

Use a snapshot to save successful analysis results and reuse them on later runs. REA reuses a result only when the target bytes, operation, parameters, analysis tool, and settings match. It does not cache changes or cursor-dependent calls. Snapshot files stay local and use owner-only permissions.

```bash
rea analyze /absolute/path/to/app --snapshot /absolute/path/to/analysis/app.json
# The same exact query can be answered from that snapshot.
rea analyze /absolute/path/to/app --snapshot /absolute/path/to/analysis/app.json
```

Exact CLI cached-evidence reads happen before any provider process starts. In MCP sessions,
pass `snapshot_path` to `open_binary` to import a snapshot atomically while
opening its matching target; MCP providers may still start before a cached call
result is returned. Pass `snapshot_path` and, when required, `overwrite: true` to
`close_binary` to save atomically before Hopper resources are released. If the
save fails, REA deliberately leaves the session open.

## Just ask your agent

After [setup](#quick-start), restart your agent and ask:

```text
Understand how search works in the Notes app, show me the evidence, and build a
similar feature for my project.
```

Replace Notes with the app you want to understand, or ask for an overview first.

## The investigation model

<table>
<tr>
<td width="33%" valign="top">
<strong>Decompile</strong><br /><br />
Open an app and recover readable code, strings, names, and other clues about how it works.
</td>
<td width="33%" valign="top">
<strong>Understand</strong><br /><br />
Follow the code from one part of the app to another until the agent can explain how a feature actually works.
</td>
<td width="33%" valign="top">
<strong>Recreate</strong><br /><br />
Turn what the agent learned into a feature for your own product, adapted to your stack, interface, and requirements.
</td>
</tr>
</table>

REA shows how it reached its conclusions. It does not claim to recover original source code or automatically clone an application.

## Why REA

|                          |                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| **Built for agents**     | Ask what an app does and let your agent inspect it instead of guessing.                               |
| **CLI and MCP**          | Run the same reverse-engineering capabilities from your terminal or agent.                            |
| **Guided setup**         | Configure your agent, connect an existing analysis tool, or install Hopper with your approval.        |
| **From insight to code** | Understand a feature, then build your own version in the same coding session.                         |
| **Local by design**      | Analysis runs on your supported local host. REA does not upload the app to a hosted analysis service. |
| **Keeps context**        | Investigate several apps without starting over for every question.                                    |

## One prompt, a full investigation

```text
Reverse engineer the Notes app. Find how offline search works, explain it,
and build a version for my project using TypeScript and SQLite.
```

REA gives the agent a clear path from that request to working code:

| Step | What the agent does                     | REA tools                                                        |
| ---: | --------------------------------------- | ---------------------------------------------------------------- |
|    1 | Opens and identifies the binary         | `open_binary`, `binary_overview`                                 |
|    2 | Finds likely offline-search clues       | `search_strings`, `search_procedures`, `list_names`              |
|    3 | Connects those clues to executable code | `find_xrefs_to_name`, `xrefs`, `procedure_callers`               |
|    4 | Reconstructs the relevant control flow  | `get_call_graph`, `procedure_callees`, `procedure_info`          |
|    5 | Decompiles the relevant routines        | `procedure_pseudo_code`, `procedure_assembly`, `batch_decompile` |
|    6 | Builds the feature in your project      | code adapted to your stack, product, and requirements            |

REA handles the app analysis in steps 1 through 5. The agent performs step 6 with its normal file-editing and test tools, using what it learned about the app.

## Showcase

### DX-Ball: game reconstruction (in progress)

[DX-Ball](https://github.com/N0zoM1z0/dx-ball) follows the journey from a classic
Windows game's executable to maintainable C. Using REA's Ghidra provider, the
project traces functions, game state and dependencies, then checks reconstructed
behavior with original-x86 differential tests and pinned-compiler replay.

A [sound-pan investigation](https://github.com/N0zoM1z0/dx-ball/blob/main/docs/GAMEPLAY_OWNER.md)
turns incomplete pseudocode into a C implementation that passes 3,205 original-x86
cases and reproduces all 63 compiled function bytes. Follow its
[REA workflow](https://github.com/N0zoM1z0/dx-ball/blob/main/docs/REA.md)
from binary evidence to reconstruction.

## What agents can do

- Investigate a feature you like and build a version tailored to your own product.
- Explain how a feature works when its source code is unavailable.
- Reconstruct an app's authentication, storage, update, or networking flow.
- Recover enough structure to document an undocumented format or interface.
- Trace a suspicious behavior from a string or symbol to the code that implements it.
- Turn recovered behavior into product features, tests, migration notes, ports, or interoperable replacements.
- Analyze Swift and Objective-C metadata without manually untangling every mangled symbol.
- Leave names, comments, and bookmarks in Hopper so human and agent analysis reinforce each other.

See [native investigation](docs/native-investigation.md) for keyed archives, instruction/call/type primitives, typed dispatch metadata, value traces and native desktop observation.

## Tool catalog for investigation

| Tool family               | Count | Examples                                                                                                                                                                                                 |
| ------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native inspection         |    41 | functions, pseudocode, assembly, strings, symbols, calls, references, annotations, byte reads, and file offsets                                                                                          |
| Investigation workflows   |    14 | app overviews, function dossiers, native APIs and dispatch, batch decompilation, feature traces, call paths, call graphs, Swift and Objective-C discovery                                                |
| Native macOS utilities    |     7 | Mach-O metadata, code signatures, plists, architectures, and Swift demangling without launching Hopper                                                                                                   |
| Artifact graph            |     5 | directory and package inventories, compiled Interface Builder files, Apple asset catalogs, and extraction                                                                                                |
| Managed PE/CLI            |     7 | .NET identity, metadata, CIL instructions, native dependencies, reconstruction imports, and build comparisons                                                                                            |
| Firmware                  |     2 | Linux firmware region inspection and explicit extraction                                                                                                                                                 |
| Android APK               |     5 | package and manifest declarations, class search, member inventories, method decompilation, and incoming static references                                                                                |
| Browser observation       |    11 | page structure, network metadata, scripts, source maps, WebMCP discovery, screenshots, and capture comparisons                                                                                           |
| Electron analysis         |     5 | renderer observation, static app mapping, and static/runtime reconciliation                                                                                                                              |
| JavaScript runtime        |     2 | Node/Electron Inspector target discovery, script locations, and execution-context events                                                                                                                 |
| Application workflows     |    13 | captured website script export; Android/Apple inventory projections; cross-layer feature traces, build comparisons, historical source mapping, static return-shape comparison, and reconstruction checks |
| Workspace and observation |    21 | sessions, evidence bundles, navigation context, process/artifact/function comparisons, and open-question tracking                                                                                        |

The public interface describes what the agent is trying to learn. Providers decide how to answer. macOS utilities handle common semantic inspection without launching Hopper; Hopper handles deeper native analysis; the process harness records direct behavioral captures.

## Current status

REA supports native application, JavaScript, Electron, .NET, and browser investigation on macOS and Linux. Individual tools have platform and runtime prerequisites. `rea capabilities` and `rea providers` describe the binary-session providers and auxiliary operations; they are not an inventory of every browser, Android, or application workflow. Use the connected MCP tool list and `binary_session` tool availability for the full MCP surface, and the relevant guide for each tool's prerequisites. Repository main can be ahead of [the npm release](docs/installation.md#released-package-and-main).

Static Android APK inspection supports Linux and macOS; the current metadata bridge is verified on macOS arm64 with headless JADX; see [Android analysis](docs/android-analysis.md) for its separate prerequisites and coverage.

- **Native binaries:** Open Mach-O, ELF, PE, and Mac `.app` targets through a selected deep provider. Hopper and Ghidra cover broad inventory and function analysis; the IDA adapter supplies its documented read-only function/string operations. Hopper also accepts `.hop` databases and supports annotations.
- **Packages and resources:** Inspect directories, ZIP, APK, IPA, ASAR, plists, compiled Interface Builder files, and Apple asset catalogs. Artifact requests name the input and requested extraction or traversal directly; macOS DMG traversal also requires the host's native mounting support.
- **JavaScript and Electron:** Map modules, imports, source maps, routes, IPC channels, storage, and native add-ons without running the app. Compare builds and trace a feature across the recovered graph. Dynamic and ambiguous relationships remain unresolved. See [JavaScript application workflows](docs/javascript-application-workflows.md).
- **Websites:** Inspect a selected page in an existing Chrome-family browser. Capture page structure, network metadata, script evidence, and screenshots requested by the call. Passive observation does not navigate or execute page JavaScript. See [browser observation](docs/browser-observation.md).

  Export retained scripts with `export_web_scripts` / `rea export-web-scripts`
  into a verified local directory, then use the existing JavaScript analysis
  and tracing tools. Source URLs, frame or transaction references, competing
  versions, and missing-source states remain inline. See
  [captured website scripts](docs/website-script-export.md).
  Inspect a selected node's listener sources or observe an externally triggered
  execution window with `inspect_web_event_listeners` / `observe_web_execution`.
  Precise coverage resets counters and affects optimized execution; see
  [website runtime attribution](docs/web-runtime.md).
  Trace one exported script's native imports with `trace_web_module_imports` /
  `rea trace-web-module-imports`, preserving query/fragment identity and optional
  import-map context. Requires caller-supplied Chromium via
  `REA_BROWSER_EXECUTABLE`; see [module relationships](docs/website-module-trace.md).

- **Source locations:** Trace one retained website script point through a selected
  local source map with `rea trace-web-source-location`. See
  [captured website source locations](docs/web-source-location.md) for byte
  identities, embedded original content and coverage limits.
  Recover readable modules from selected local bundles with
  `recover_javascript_sources` / `rea recover-javascript-sources`, then pass
  the returned `analysis_input` to static analysis. This optional Linux x64
  adapter requires caller-supplied Wakaru 1.13.0; see
  [JavaScript source recovery](docs/javascript-recovery.md).

- **Electron and Node runtime observation:** Inspect selected Electron pages or attach to a Node/Electron V8 Inspector target. Inspector observation records script locations and execution-context events; it does not infer imports, IPC activity, or which modules executed. See [runtime observation](docs/javascript-runtime-observation.md).
- **.NET assemblies:** Inspect metadata and CIL instructions, compare builds, and check declared native dependencies without loading or running the assembly. Imported decompiler output is labeled as analyst inference. See [managed-code analysis](docs/managed-code-analysis.md).
- **Controlled behavior capture:** Run process, browser, or Electron scenarios with the target, actions, and lifecycle declared in each request, then compare the resulting evidence. Missing observations cannot establish that two runs behaved the same way.
- **Evidence and comparison:** Save results with artifact identity, provider, locations, confidence, and limitations. Export or import bundles, compare artifacts and functions, and connect static findings to runtime observations without claiming causality from correlation.
- **Open questions:** Track unresolved findings, contradictions, and follow-up probes. Reconstruction checks report pass, fail, or unknown rather than treating missing evidence as a pass.
- **Guided workflows:** Start six [MCP investigation workflows](docs/mcp-prompts.md) with suggestions based on your current session.

Windows x64 Ghidra P0 supports native, non-managed, non-DLL x86-64 PE applications on fixed local NTFS with 25 read-only operations. Linux/macOS Ghidra additionally supports atomic session-scoped function names and entry comments. Ghidra has no GUI controls; Windows P0 has no mutation authority.

### Website observation with CDP

REA can inspect an already-running Chrome-family browser through a literal loopback CDP endpoint. Each request names the endpoint and target; an optional origin filter can narrow discovery:

```bash
rea list-browser-targets http://127.0.0.1:9222 --json
rea inspect-web-page http://127.0.0.1:9222 TARGET_ID --json
```

The eight passive browser tools work through both CLI and MCP. They inspect the selected page without navigating, clicking, or evaluating its JavaScript. Credentials, cookies, authorization headers, and raw payload values are not retained. A request selects whether to include script sources, accessibility text, screenshots, or console and payload summaries. REA cannot observe activity that happened before it attached. See [browser observation](docs/browser-observation.md) for browser startup, capture options, and limits.

### Controlled browser scenarios

`capture_browser_scenario` runs a caller-declared sequence of browser actions through
Playwright. Unlike passive observation, it can interact with the page. Each
step records evidence such as screenshots, page structure, navigation, and
network activity. Missing or truncated observations cannot establish that two
runs behaved the same way.

```bash
rea capture-browser-scenario ./scenario.json --json
```

Launch mode owns a temporary browser profile and removes it after terminating
the launched browser. Connect mode accepts one exact loopback CDP target and
disconnects without closing the external browser. The request supplies the
selected executable or endpoint, actions, and any origin or environment
selections needed by the scenario. Scenario JSON contains secret references and
environment-variable names, never secret values. The default capture retains
only the final URL; request `dom`, `accessibility`, or `screenshot` when an
interaction changes the page without navigating. For asynchronous updates,
wait for a page-specific result-ready condition before capture. See the
[browser scenario contract](docs/browser-scenario-contract.md), including its
interaction example.

### Node and Electron V8 Inspector observation

Node and Electron runtime observation attaches to an existing Inspector target named in the request:

```bash
rea list-javascript-runtime-targets http://127.0.0.1:9229 --json
rea observe-javascript-runtime http://127.0.0.1:9229 TARGET_ID \
  --runtime-kind node --json
```

REA records script locations and execution-context events without evaluating
code or setting breakpoints. These observations do not establish import
relationships, event activity, IPC, process identity, or Electron roles. See
[Node and Electron runtime observation](docs/javascript-runtime-observation.md)
for the exact coverage.

Exact package, tool-family, provider, setup-client, schema, and CLI facts are generated from source in [`docs/product-catalog.json`](docs/product-catalog.json). PR CI verifies this catalog, narrative documentation, and generated schemas.

## Roadmap

The [current status](#current-status) section describes shipped capabilities. These are the next areas of work.

### Now

1. **Keep documentation accurate:** update the generated catalog and documentation checks when tools, providers, setup options, or versions change.
2. **Test more native binaries:** expand architecture and indirect-call coverage across Hopper and Ghidra.

### Next

1. **Connect more application layers:** add static extractors and runtime observations to feature traces.
2. **Extend .NET analysis:** improve comparisons of obfuscated assemblies and connect managed findings to verified native analysis. See the [managed-code guide](docs/managed-code-analysis.md).
3. **Compare more runtime behavior:** expand process, protocol, filesystem, reconnect, and version-comparison coverage.

### Later

1. **Expand browser and Electron interaction:** add scenario actions beyond the current click and wait operations.
2. **Observe native apps at runtime:** explore LLDB, Frida, system logs, and native API tracing.
3. **Evaluate more tools and targets:** assess Binary Ninja, Rizin, LIEF, Windows-native tools, mobile apps, and firmware. IDA support already ships via the bring-your-own upstream adapter; see the [IDA provider guide](docs/ida-provider.md).

Setup already lets you choose agent integration and Hopper installation. Support for installing additional analysis tools is future work, described in the [installation roadmap](docs/roadmap.md).

See [provider evaluation](docs/provider-evaluation.md) for coverage and remaining requirements, and the [native investigation guide](docs/native-investigation.md) for UI, dispatch, and value-flow analysis.

## Using REA with other agents

Setup offers supported agent integrations for selection. Existing REA registrations are selected by default; newly detected agents remain unselected until chosen. Any agent that supports local MCP servers can use the configuration below.

### Manual MCP configuration

<!-- x-release-please-start-version -->

```json
{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ["-y", "rea-agents@4.1.0", "mcp"]
    }
  }
}
```

<!-- x-release-please-end -->

Persistent registrations should use one exact package version. `rea setup`
maintains that pin, updates the bundled skill at the same time, and gives Codex
a 30-second startup allowance for a cold package-runner start. `rea update`
installs an exact release and verifies the new executable. It returns an
unapplied maintenance plan for existing REA integrations, with a scoped setup
command to review and approve their changes. Restart affected agents afterward.

MCP clients that support prompts can also discover six ordered investigation
workflows through `prompts/list`. Their optional identifier arguments use the
current session for bounded `completion/complete` suggestions; see
[Guided MCP prompts and completion](docs/mcp-prompts.md).

## How it works

```mermaid
flowchart LR
    Agent["Agent"] --> REA["REA<br/>CLI + MCP"]
    Terminal --> REA
    REA --> Session["Target-bound session router"]
    Session --> Registry["Deep-provider registry<br/>deterministic selection"]
    Registry --> Hopper["Hopper provider"]
    Registry --> Ghidra["Ghidra provider<br/>inventory + function analysis + annotations"]
    Registry --> Ida["IDA MCP provider<br/>attached GUI or owned headless database"]
    Hopper --> Runtime["Owned provider runtime<br/>deadline + bounded diagnostics + cleanup"]
    Ghidra --> Runtime
    Ida --> IdaRuntime["Upstream MCP lifecycle<br/>live observations + owned database cleanup"]
    IdaRuntime --> Target
    Session --> Native["Native macOS provider"]
    Session --> Artifact["Artifact graph provider"]
    REA --> Browser["Browser CDP provider"]
    REA --> Android["Android static provider<br/>headless JADX adapter"]
    Android --> Runtime
    REA --> Firmware["Firmware providers<br/>Binwalk / Unblob adapters"]
    Firmware --> Runtime
    REA --> Process["Process capture provider"]
    Runtime --> Target["Target software"]
    Process --> Target
    Native --> Target
    Artifact --> Target
```

The CLI and MCP server use the same application workflows and evidence contracts. A provider declares which capabilities it supports and the side effects those capabilities may have. Terminal commands are short-lived; an MCP session can retain an active target and evidence ledger for the session.

## CLI

The agent workflow above is the easiest way to use REA. For a one-off overview from the Terminal:

```bash
npx -y rea-agents@latest analyze /Applications/Notes.app
npx -y rea-agents@latest inspect /Applications/Notes.app
npx -y rea-agents@latest search /Applications/Notes.app "offline"
npx -y rea-agents@latest function /Applications/Notes.app 0x1000
npx -y rea-agents@latest xrefs /Applications/Notes.app 0x1000
npx -y rea-agents@latest trace /Applications/Notes.app "offline"
npx -y rea-agents@latest compare /absolute/path/to/left-evidence.json /absolute/path/to/right-evidence.json
npx -y rea-agents@latest capabilities
npx -y rea-agents@latest providers
```

Run `npx -y rea-agents@latest --help` for direct decompilation, bounded search and
other options. `analyze` and `inspect` share the same overview workflow;
`function`, `xrefs`, and `trace` return the same Evidence envelopes as MCP.

Or install the `rea` command globally:

```bash
npm install --global rea-agents
rea --help
rea update
rea mcp
```

REA accepts a Mac `.app` folder directly. If an agent cannot find an app by name, tell it where the app is installed.

### Choosing a deep-analysis provider

Choose which analysis tool to use from the CLI:

```bash
rea providers --json
rea analyze /absolute/path/to/program --provider hopper
REA_ANALYSIS_PROVIDER=hopper rea decompile /absolute/path/to/program 0x1000
```

For MCP, pass the optional selector on `open_binary`:

```json
{
  "path": "/absolute/path/to/program",
  "provider_id": "hopper"
}
```

Use `--provider`, or `provider_id` in MCP, to choose Hopper, Ghidra, or IDA for a target. This choice overrides `REA_ANALYSIS_PROVIDER`.

With `auto`, REA selects the only available tool that supports the target. If both are available, specify one before opening the target. The session keeps that choice until you explicitly switch or close it; a failure never silently switches tools. Artifact-only analysis can work without a native analysis tool.

Run `rea providers` and `rea capabilities` to check availability and supported operations. Ghidra supports inspection and atomic function annotation edits on Linux and macOS. Its database edits are discarded on close; GUI controls require Hopper. Windows Ghidra P0 supports read-only analysis of native x86-64 PE applications on local NTFS with bundled native controls.

The session also reports active work and cleanup status. If a caller times out, the analysis tool may still be busy; `analysis_activity` reports that state. A `cleanup_incomplete` result identifies resources whose shutdown or removal could not be verified. See [provider selection and analysis profiles](docs/adr/0001-provider-selection-and-analysis-profiles.md) for session, cache, and process-tracking details.

### CLI exit status

| Status    | Meaning                                                                                                                                                                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`       | The operation completed. Results may still include warnings, partial evidence, or unresolved questions.                                                                        |
| `1`       | The operation could not complete, for example because of invalid input, host permission denial, cancellation, or timeout. Structured output reports the reason when available. |
| `128 + N` | The process ended from signal `N`, where the shell or runtime preserves the conventional signal-derived status.                                                                |

`setup --dry-run` returns status `planned` and exits `0`. A setup result with
status `cancelled` also exits `0`.
`setup` returns `1` for `needs_confirmation` or `needs_human`
because configuration is not ready; rerun it after approval or remediation.
`doctor` returns `1` when required checks for its readiness scope are unhealthy.
Unavailable optional provider prerequisites remain visible as informational
diagnostics and do not block setup or unrelated providers. Output format, full envelopes,
filters, and token controls never change the operation status.

When REA feeds a shell pipeline, enable `pipefail` so a downstream formatter
cannot hide its failure:

```bash
set -o pipefail
rea inspect-artifact ./app.asar --json | jq . > inspection.json
```

## Current Hopper provider

REA starts Hopper when an operation needs it. On macOS, Hopper may bring its window or a dialog to the foreground even though REA requests background startup. Demo or license prompts may need your attention.

Hopper handles one analysis request at a time. Cancelling your wait does not stop work already running inside Hopper; the session reports whether it is still busy. Successful decompilation results are cached until a relevant rename or comment change.

Use `rea instructions` when you only need assembly instructions for a function. It avoids decompilation and a whole-program inventory.

Closing a session shuts down REA's bridge and removes its temporary socket directory while preserving a Hopper application you may be using. If cleanup cannot be verified, `close_binary` reports `cleanup_incomplete` and the affected resources.

## Process capture

Process capture runs the exact executable and scenario declared in the request,
with the requested working directory and environment. Filesystem observation
paths select what to snapshot. The process runs with your user permissions;
Process Capture records behavior and is not a security sandbox.

Capture a scenario or compare two saved Process Capture Evidence records:

```bash
rea capture-process ./authority-scenario.json --json > authority-capture.json
rea capture-process ./reconstruction-scenario.json --json > reconstruction-capture.json
rea compare-process-captures authority-capture.json reconstruction-capture.json --json
```

The comparison reports each observed dimension separately and identifies the
first terminal, interaction, exit, filesystem, or process divergence.
See [Process Capture](docs/process-capture.md) for scenario fields, limits, and
evidence boundaries.

Process Capture currently runs on Linux and macOS with a working native PTY
backend. Native Windows capture remains unavailable until the PTY adapter can
verify descendant cleanup; installing or reinstalling its Windows PTY binary
does not enable capture. For Linux commands, run Linux REA inside WSL.
Comparing existing capture Evidence remains available on Windows.

On supported capture hosts, a missing or incompatible PTY binary can be fixed
by reinstalling REA for the current platform, architecture, and Node.js version
with optional dependencies enabled. Use separate scenario and output files;
`--json` produces the JSON consumed by the comparison command.

ASAR inventory verifies Electron integrity metadata for both archive entries
and `.asar.unpacked` companion files. Integrity failures identify the logical
path, declared and calculated SHA-256 values, and whether the entry was
unpacked; REA does not silently accept the mismatched artifact. If a supplied
ASAR declares unpacked companion bytes that are absent from the local artifact
set, REA keeps that occurrence as `unavailable` and continues analyzing the
embedded JavaScript instead of treating the missing native/resource bytes as
verified or absent.

## Security model

Analysis runs locally. REA communicates with Hopper and Ghidra through authenticated private local sockets and with IDA through its configured local MCP registration. Your agent or model provider has its own data policy.

Runtime requests act on the declared target and lifecycle. Analysis tools and launched targets run with your user permissions, and native UI capture still depends on macOS Accessibility and Screen Recording access. Static JavaScript analysis does not execute extracted modules; use direct browser, Electron, or process capture when runtime behavior is needed.

Windows Ghidra P0 automatically uses native Job Objects, protected private-runtime DACLs, and handle-based admission. Its experimental scope is native x86-64 PE applications on local NTFS. Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

## FAQ

<details>
<summary><strong>Does Hopper need to be running before I start REA?</strong></summary>

No. REA starts Hopper when an operation needs it. An already-running Hopper application is also supported.

</details>

<details>
<summary><strong>Why did Hopper appear in front of my other windows?</strong></summary>

Hopper's launcher internally activates the application. REA requests background startup, but macOS and Hopper may still bring a window or dialog forward. See [Current Hopper provider](#current-hopper-provider).

</details>

<details>
<summary><strong>Does REA include Hopper?</strong></summary>

No. Setup can install Hopper for you, but Hopper remains separate software with its own license. REA supplies the CLI, MCP server, and workflows that make it usable by agents.

</details>

<details>
<summary><strong>Does REA install or include Ghidra or Java?</strong></summary>

No. REA connects to an existing Ghidra installation. Run setup after providing the Ghidra and Java paths shown in the [Ghidra section](#ghidra-analysis-provider).

</details>

<details>
<summary><strong>Does REA upload the app?</strong></summary>

REA has no hosted analysis service. Current providers analyze artifacts and capture behavior locally. Your agent or model provider may have its own data policy, so review that separately.

</details>

<details>
<summary><strong>Can REA recover the original source code?</strong></summary>

No decompiler can guarantee the original source. REA gives an agent pseudocode, assembly, symbols, strings, metadata, and relationships that it can use to explain or compatibly recreate observed behavior.

</details>

<details>
<summary><strong>Which agents can use REA?</strong></summary>

Any agent that can run a local MCP server can use the manual configuration. Setup offers the supported integrations listed in [Installation and setup](docs/installation.md#supported-agents); existing REA registrations are selected by default, and other detected agents require selection.

</details>

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and contribution checks, and [docs/testing.md](docs/testing.md) for test scopes and real-tool verification. `npm run docs:check` checks committed generated documents; `npm run docs:generate` regenerates them.

`npm run verify:agent` evaluates native, JavaScript, managed, and browser investigation tasks through a real local Codex CLI. Its report covers tool selection, repeated calls, token use, completion quality, and handling of permissions and unknowns.

`npm run evidence:generate` regenerates the managed conformance manifest and Evidence completion ledger from live verification results. `npm run evidence:check` reruns verification and checks for drift. Unsupported claims remain explicit and do not count as passes. See [testing](docs/testing.md) for verification commands and process-cleanup checks.

## Project links

[npm](https://www.npmjs.com/package/rea-agents) · [Issues](https://github.com/morluto/rea/issues) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Hopper](https://www.hopperapp.com/) · [Ghidra](https://github.com/NationalSecurityAgency/ghidra)

## License

[MIT](LICENSE)

## Star history

<a href="https://www.star-history.com/?repos=morluto%2Frea&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date&amp;theme=dark&amp;legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
    <img alt="REA GitHub star history" src="https://api.star-history.com/chart?repos=morluto/rea&amp;type=date" />
  </picture>
</a>

## Disclaimer

REA provides tools for lawful reverse-engineering research, analysis, and reconstruction. You are responsible for obtaining any required authorization and complying with applicable laws. The project does not endorse illegal or unauthorized use.
