<div align="center">

**English** · [简体中文](README_zh.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [العربية](README_ar.md)

# REA: Reverse Engineer Anything

### One CLI and MCP server for coding agents to reverse engineer anything

**See a feature you like. Understand how it works, down to the binary level.**

[![npm version](https://img.shields.io/npm/v/rea-agents?style=flat-square&color=cb3837)](https://www.npmjs.com/package/rea-agents)
[![CI](https://img.shields.io/github/actions/workflow/status/morluto/rea/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/morluto/rea/actions/workflows/ci.yml)
[![68 MCP tools](https://img.shields.io/badge/MCP_tools-68-5c4ee5?style=flat-square)](#68-tools-for-investigation)
[![Node.js 24](https://img.shields.io/badge/Node.js-24.18.x-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](LICENSE)

[Quick start](#quick-start) · [Current status](#current-status) · [Investigation model](#the-investigation-model) · [68 tools](#68-tools-for-investigation) · [Roadmap](#roadmap) · [How it works](#how-it-works)

<br />

<code>npx skills add morluto/rea</code>

</div>

---

See a feature in an app that you want in your own product? Give the app to your coding agent—even without its source code. With REA, the agent can investigate the feature, explain how it works, show its evidence, and build a version adapted to your stack and requirements.

REA gives agents one consistent way to investigate software. Today that includes deep native analysis through Hopper, complete function dossiers, reproducible Evidence v2 records, and controlled process capture. The longer-term toolkit extends the same agent workflow to packaged apps, JavaScript bundles, websites, APIs, protocols, mobile artifacts, firmware, runtime behavior, and differences between versions.

Reverse engineering normally makes the operator choose a tool, learn its API, move evidence between programs, and decide what to inspect next. REA gives that work to the agent through commands, skills, structured results, and repeatable investigation workflows.

## Just ask your agent

Install the REA skill:

```bash
npx skills add morluto/rea
```

Then ask:

```text
Set up REA and reverse engineer the Notes app. Explain how search works,
show me how you know, and build a similar feature for my project.
```

Notes is only an example. Name any app you want to understand, or ask the agent to start with an overview.

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

|                          |                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------ |
| **Built for agents**     | Ask what an app does and let your agent inspect it instead of guessing.              |
| **CLI and MCP**          | Run the same reverse-engineering capabilities from your terminal or coding agent.    |
| **Complexity handled**   | REA installs and manages the reverse-engineering tools behind the scenes.            |
| **From insight to code** | Understand a feature, then build your own version in the same coding session.        |
| **Local by design**      | Analysis runs on your Mac. REA does not upload the app to a hosted analysis service. |
| **Keeps context**        | Investigate several apps without starting over for every question.                   |

## Quick start

### With a coding agent — recommended

```bash
npx skills add morluto/rea
```

Ask your agent to set up REA. It will check your Mac, explain anything it needs to install, ask for approval, and guide you through system prompts. After setup, restart the agent if it asks you to load the full REA toolset.

### From Terminal

```bash
npx -y rea-agents setup --yes
```

If macOS or an installer asks for confirmation, complete the prompt and run the same command again. Restart a configured coding agent so it loads REA.

### What setup handles

- macOS 12 or newer
- Node.js 24.18.x with npm 11.16.x (`nvm use` selects the pinned version)

If process capture reports that its native PTY backend is unavailable, install Xcode command-line tools and run `npm run rebuild:native`. Linux source builds require Python, `make`, and a C++ toolchain. Compatible packaged binaries do not require this rebuild.

Process capture is disabled by default. Enabling it requires
`REA_PROCESS_CAPTURE_ENABLED=true`, approved executable and working roots in
`REA_PROCESS_EXECUTABLE_ROOTS_JSON` and `REA_PROCESS_WORKING_ROOTS_JSON`, and an
environment allowlist in `REA_PROCESS_ALLOWED_ENV_JSON`. The current PTY adapter
uses host networking, so it additionally requires the explicit operator grant
`REA_PROCESS_ALLOW_EXTERNAL_NETWORK=true`. Without that grant the adapter
refuses to launch; loopback replay alone does not constitute network isolation.

You do not need to install the reverse-engineering tools manually. Setup installs Homebrew and [Hopper](https://www.hopperapp.com/) when needed, configures detected Claude Desktop and Cursor installations, and installs the REA skill. Hopper is separate software and requires its own license; setup installs it but does not provide a license.

If something is not working, run:

```bash
npx -y rea-agents doctor
```

### CLI or coding agent?

| If you want to…                                           | Use                                            |
| --------------------------------------------------------- | ---------------------------------------------- |
| Ask an agent to investigate an app and build a feature    | Install the skill, then talk to your agent     |
| Inspect or decompile one part of an app from the Terminal | `rea analyze` or `rea decompile`               |
| Validate or canonicalize an Evidence v2 bundle            | `rea evidence-import` or `rea evidence-export` |
| Import source as historical reference                     | `rea import-reference-source`                  |

Filesystem evidence commands and MCP file tools are disabled until the operator approves absolute roots:

```bash
export REA_EVIDENCE_ROOTS_JSON='["/absolute/path/to/evidence"]'
rea evidence-import /absolute/path/to/evidence/bundle.json
rea evidence-export /absolute/path/to/evidence/bundle.json /absolute/path/to/evidence/canonical.json
```

Historical source import requires a separate allowlist and never treats source as current behavioral authority:

```bash
export REA_REFERENCE_ROOTS_JSON='["/absolute/path/to/source"]'
rea import-reference-source /absolute/path/to/source
```

Exports never replace an existing file unless `--overwrite` is explicit. Imports are size/depth bounded, validate every Evidence v2 ID and manifest, and never execute bundle content.

Completion metadata is verifier-owned. Run `npm run completion:generate` after changing contracts, schemas, providers, scenarios, package metadata, verifier inputs, or the managed skill. CI runs `npm run completion:check`; it detects stale or tampered hashes and never rewrites a branch. Unsupported and unknown outcomes remain separate from passes, and a pass or failure requires indexed Evidence v2 IDs.

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

REA handles the app analysis in steps 1–5. The agent performs step 6 with its normal file-editing and test tools, using what it learned about the app.

## What agents can do

- Investigate a feature you like and build a version tailored to your own product.
- Explain how a feature works when its source code is unavailable.
- Reconstruct an app's authentication, storage, update, or networking flow.
- Recover enough structure to document an undocumented format or interface.
- Trace a suspicious behavior from a string or symbol to the code that implements it.
- Compare implementation paths across two app versions by switching targets in one session.
- Turn recovered behavior into product features, tests, migration notes, ports, or interoperable replacements.
- Analyze Swift and Objective-C metadata without manually untangling every mangled symbol.
- Leave names, comments, and bookmarks in Hopper so human and agent analysis reinforce each other.

## 68 tools for investigation

| Tool family               | Count | Examples                                                                                                                |
| ------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------- |
| Native inspection         |    33 | procedures, pseudocode, assembly, strings, names, segments, callers, callees, xrefs, annotations                        |
| Investigation workflows   |    10 | `binary_overview`, `analyze_function`, `batch_decompile`, `trace_feature`, call graphs, Swift and Objective-C discovery |
| Native macOS utilities    |     5 | Mach-O metadata, code signatures, plists, architectures, Swift demangling; Hopper-free and provenance-bearing           |
| Artifact graph            |     2 | deterministic directory, ZIP/APK/IPA, and ASAR inventory; explicitly selected transactional extraction                  |
| Workspace and observation |    18 | target lifecycle, Evidence v2 bundles, process/artifact/function comparison, evidence-linked residual-unknown lifecycle |

The public interface describes what the agent is trying to learn. Providers decide how to answer. macOS utilities handle common semantic inspection without launching Hopper; Hopper handles deeper native analysis; the process harness implements controlled behavioral capture.

## Current status

REA is already useful for native application investigation on macOS:

- Open Mach-O, ELF, PE, `.app`, ZIP, APK, IPA, ASAR, plist, JavaScript, source-map, and Hopper database targets.
- Traverse content-addressed artifact graphs without extraction; materialize only approved occurrences into absent output roots.
- Build bounded function dossiers with pseudocode, assembly, CFG edges, comments, calls, references, strings, and names.
- Search and trace features across symbols, strings, metadata, references, and call paths.
- Record every successful result as deterministic Evidence v2 with artifact and provider identity, confidence, authority, limitations, and locations.
- Export and import evidence bundles across sessions.
- Capture approved PTY scenarios, child processes, filesystem changes, and loopback HTTP/WebSocket exchanges, then compare normalized captures.
- Compare complete artifact inventories by stable path, content, metadata, and relations; incomplete evidence never implies equivalence.
- Compare explicit function dossiers across text, calls, references, strings, and address-normalized CFG topology with per-facet unknowns.
- Compare canonical Evidence bundles by exact membership, explicit observation pairs, and residual-unknown histories without turning omissions into behavioral absence.
- Aggregate runtime comparisons into observed behavior changes while keeping static artifact/function differences labeled as candidates.
- Build bounded, Evidence-cited direct call paths by exact address without treating missing dossiers as graph leaves.
- Correlate exact static/runtime findings through explicit hypotheses without claiming causality from cochange.
- Verify finite behavioral and structural reconstruction specifications with pass, fail, and unknown kept distinct.
- Track residual unknowns through immutable CAS revisions, evidence-qualified resolution, contradictions, probes, and validated dependency relationships.
- With explicit `unknown_registry_approved: true`, record bounded trace/capture residuals, typed provider unavailability, and capture disagreements automatically.

Hopper is the first provider, not the boundary of the project. Some current workflows still require Hopper and macOS; every evidence record identifies the provider and limitations behind its result.

## Roadmap

REA is growing into a toolkit for understanding software across static artifacts and observed behavior. The next capability families are:

1. **Artifact decomposition** — DMG, ASAR, ZIP, packages, universal-binary slices, application resources, embedded frameworks, mobile packages, and artifact graphs.
2. **Web and Electron investigation** — Playwright/CDP capture of DOM, accessibility trees, screenshots, storage, console, IPC, HTTP, WebSocket, routes, and visual or structural differences.
3. **Deterministic behavior harnesses** — stronger process-tree ownership, protocol fixtures, network policy, filesystem tracing, signals, reconnects, and cross-version comparison.
4. **JavaScript and source recovery** — bundle indexing, AST/module reconstruction, source-map discovery, historical-source matching, and CodeDB-backed cross-references.
5. **Runtime observation** — approval-gated LLDB, Frida, system logs, process and filesystem observers, and native API tracing.
6. **More static-analysis providers** — native platform utilities first, followed by Ghidra, IDA/Hex-Rays, Binary Ninja, Rizin, LIEF, and other engines behind provider-neutral capabilities.
7. **More targets and platforms** — Windows-native providers and ConPTY verification, Linux parity, websites and APIs, mobile artifacts, firmware, document formats, and other software-defined systems.
8. **Differential reconstruction** — compare artifacts, functions, bundles, protocols, UIs, and process captures; track residual unknowns; verify a reconstruction against observed behavior.

Roadmap items describe direction, not shipped support. New providers must produce the same evidence and safety metadata as existing capabilities before they become part of the public workflow.

## Using REA with other coding agents

Setup currently configures Claude Desktop and Cursor automatically. Any coding agent that supports local MCP servers can use REA with the configuration below.

### Manual MCP configuration

```json
{
  "mcpServers": {
    "rea": {
      "command": "npx",
      "args": ["-y", "rea-agents", "mcp"]
    }
  }
}
```

## How it works

```mermaid
flowchart LR
    Agent["Coding agent"] --> REA["REA<br/>CLI + MCP"]
    Terminal --> REA
    REA --> Workspace["Investigation workspace<br/>evidence + artifacts + captures"]
    Workspace --> Router["Capability router"]
    Router --> Hopper["Hopper provider"]
    Router --> Native["Native macOS provider"]
    Router --> Artifact["Artifact graph provider"]
    Router --> Process["Process capture provider"]
    Router -. roadmap .-> More["Browser, dynamic,<br/>and additional static providers"]
    Hopper --> Target["Target software"]
    Process --> Target
    Native --> Target
    Artifact --> Target
```

The CLI and MCP server use the same application workflows and evidence contracts. A provider declares which capabilities it supports and the side effects those capabilities may have. Terminal commands are short-lived; an MCP session can retain an active target and evidence ledger across an investigation.

## CLI

The agent workflow above is the easiest way to use REA. For a one-off overview from the Terminal:

```bash
npx -y rea-agents analyze /Applications/Notes.app
```

Run `npx -y rea-agents --help` for direct decompilation and other options.

Or install the `rea` command globally:

```bash
npm install --global rea-agents
rea --help
rea mcp
```

REA accepts a Mac `.app` folder directly. If an agent cannot find an app by name, tell it where the app is installed.

## Current Hopper provider

REA starts Hopper when needed; Hopper does not need to be running first. Hopper's launcher internally activates the application, so opening a target may bring Hopper to the foreground. REA asks macOS to start Hopper hidden and in the background when possible, but cannot guarantee that it will remain behind the current application.

REA derives explicit format and architecture arguments to prevent common FAT and ARM selection dialogs. Other Hopper or macOS dialogs may still require a person. REA reports timeouts and remediation through CLI or MCP results instead of attempting to answer UI prompts.

Closing a REA session shuts down its bridge and removes its private socket directory. It does not quit a Hopper application the user may be using.

## Security model

REA does not provide a hosted analysis service. Hopper communication uses an authenticated private local socket. Dynamic capabilities are disabled by default and require both operator policy and explicit per-call approval. REA is not a security sandbox: providers and launched targets run with the current user's permissions, and each capability reports its side effects and limitations. Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

## FAQ

<details>
<summary><strong>Does Hopper need to be running before I start REA?</strong></summary>

No. REA starts Hopper when an operation needs it. An already-running Hopper application is also supported.

</details>

<details>
<summary><strong>Why did Hopper appear in front of my other windows?</strong></summary>

Hopper's launcher internally activates the application. REA requests background startup, but macOS and Hopper may still bring a window or dialog forward. See [Hopper application behavior](#hopper-application-behavior).

</details>

<details>
<summary><strong>Does REA include Hopper?</strong></summary>

No. Setup can install Hopper for you, but Hopper remains separate software with its own license. REA supplies the CLI, MCP server, and workflows that make it usable by agents.

</details>

<details>
<summary><strong>Does REA upload the app?</strong></summary>

REA has no hosted analysis service. Current providers analyze artifacts and capture behavior locally. Your coding agent or model provider may have its own data policy, so review that separately.

</details>

<details>
<summary><strong>Can REA recover the original source code?</strong></summary>

No decompiler can guarantee the original source. REA gives an agent pseudocode, assembly, symbols, strings, metadata, and relationships that it can use to explain or compatibly recreate observed behavior.

</details>

<details>
<summary><strong>Which agents can use REA?</strong></summary>

Any coding agent that can run a local MCP server can use the manual configuration. Setup currently detects and configures Claude Desktop and Cursor automatically.

</details>

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, architecture, tests, and release instructions. Generated API documentation is available under [`docs/api`](docs/api/index.html).

## Project links

[npm](https://www.npmjs.com/package/rea-agents) · [Issues](https://github.com/morluto/rea/issues) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Hopper](https://www.hopperapp.com/)

## License

[MIT](LICENSE)
