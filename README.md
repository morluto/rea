
# REA — Reverse Engineer Anything

### One MCP for reverse engineering across binaries, applications, and runtime behavior.

**See a feature you like. Understand how it works, down to the binary level.**

<p align="center">
  <a href="https://rea.tools">Website</a> ·
  <a href="https://rea.tools">Guides</a> ·
  <a href="https://rea.tools">Showcases</a> ·
  <a href="https://github.com/morluto/rea">GitHub</a>
</p>

<p align="center">
  <img src="https://img.shields.io/github/stars/morluto/rea?style=for-the-badge" alt="GitHub stars">
  <img src="https://img.shields.io/github/forks/morluto/rea?style=for-the-badge" alt="GitHub forks">
  <img src="https://img.shields.io/github/issues/morluto/rea?style=for-the-badge" alt="GitHub issues">
  <img src="https://img.shields.io/github/license/morluto/rea?style=for-the-badge" alt="License">
</p>

---

## Table of Contents

- [Introduction](#introduction)
- [Why REA?](#why-rea)
- [How REA Works](#how-rea-works)
- [Quick Start](#quick-start)
- [How to Use REA](#how-to-use-rea)
- [Installation and Setup](#installation-and-setup)
- [Supported Analysis](#supported-analysis)
- [Native Analysis Providers](#native-analysis-providers)
- [Command Line Usage](#command-line-usage)
- [Showcases](#showcases)
- [Build RL Environments](#build-rl-environments)
- [Privacy and Security](#privacy-and-security)
- [FAQ](#faq)
- [Documentation](#documentation)
- [Community](#community)
- [Contributors](#contributors)
- [Contributing](#contributing)
- [Disclaimer](#disclaimer)
- [License](#license)

---

## Introduction

**REA (Reverse Engineer Anything)** is a reverse-engineering toolkit that connects AI agents to tools for investigating applications, native binaries, websites, and runtime behavior.

With REA, you can ask an AI agent to investigate how an application works, trace a feature through its implementation, inspect supporting evidence, and help recreate similar functionality in your own project.

REA provides access through:

- Model Context Protocol (MCP).
- Command-line interface (CLI).
- Agent skills and workflow instructions.
- Static and runtime analysis tools.

Analysis runs locally. Results include evidence and limitations so that findings can be inspected rather than blindly trusted.

**Official resources:**
- Website: https://rea.tools
- Repository: https://github.com/morluto/rea
- npm package: https://www.npmjs.com/package/rea-agents

## Why REA?

Traditional reverse engineering often requires manually switching between different tools, inspecting files, tracing code, and connecting evidence.

REA brings these workflows together through an AI-agent interface.

### Key capabilities

- Investigate applications without requiring their original source code.
- Inspect native binaries and recover pseudocode or assembly.
- Analyze JavaScript and Electron applications.
- Inspect .NET assemblies and Android packages.
- Examine websites and browser behavior.
- Investigate saved network captures.
- Collect runtime evidence.
- Build reusable analysis workflows.
- Generate environments from recorded web interactions.

## How REA Works

REA connects an AI agent to its analysis tools through MCP.

```text
       Developer / User
              |
              v
          AI Agent
              |
              v
        REA MCP Server
              |
      +-------+-------+
      |       |       |
      v       v       v
   Static  Runtime  CLI Tools
  Analysis Analysis
      |       |
      +---+---+
          |
          v
   Evidence & Findings
          |
          v
    Agent Investigation
          |
          v
 Understand / Explain / Recreate
```

The agent investigates the target, receives structured findings, and uses the evidence to answer questions or guide further work.

## Quick Start

### Requirements

REA requires a supported Node.js version and npm.

Supported Node.js versions:

- Node.js 22.x (22.23.4 or later).
- Node.js 24.x (24.22.1 or later).
- Node.js 26.12.1 or later.

Additional tools depend on the type of analysis.

### Set up your agent

Run:

```bash
npx rea-agents setup
```

Choose your supported agent, review the proposed configuration changes, and approve them.

Setup registers REA's MCP server and installs matching workflow instructions. Restart your agent after setup.

### Supported agents

Setup supports:

- Claude Code
- Codex
- Cursor
- Gemini CLI
- Grok Build
- Other compatible MCP clients through manual registration

See the official installation guide for current compatibility and setup instructions.

### Ask your agent

Try this example:

```text
Understand how search works in the Notes app.
Trace the relevant implementation, show me the evidence,
explain the behavior, and help me build a similar feature
for my project.
```

Replace the example application and feature with your own target.

## How to Use REA

You can use REA through an AI agent or directly from your terminal.

### 1. Investigate an application

Ask your agent:

```text
Use REA to investigate this application.

Identify its important components, explain how they
interact, and show the evidence behind your findings.
```

### 2. Analyze a JavaScript or Electron application

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Example Windows path:

```text
D:/apps/example
```

The analysis can identify modules, imports, Electron boundaries, and related evidence.

### 3. Investigate a native binary

Configure a supported native analysis provider first.

Then ask your agent:

```text
Use REA to inspect this binary.

Identify important functions, inspect relevant instructions,
trace the behavior, and explain the evidence.
```

### 4. Investigate a website

Ask your agent:

```text
Use REA to investigate this website.

Inspect its page structure, scripts, and relevant network
observations. Explain how the selected feature works.
```

A Chrome-family browser is required for browser analysis.

### 5. Understand the results

When reviewing results, ask your agent to explain:

- What was discovered?
- Which evidence supports the conclusion?
- Which components are connected?
- What could not be verified?
- What should be investigated next?

Always review the evidence and limitations before relying on an analysis result.

## Installation and Setup

### Global CLI installation

Install REA globally:

```bash
npm install --global rea-agents
```

Check the available commands:

```bash
rea --help
```

### Update REA

For a globally installed CLI:

```bash
rea update
```

You can also use:

```bash
rea --update
```

Refresh your agent setup when prompted:

```bash
npx rea-agents@latest setup
```

Review the configuration changes and restart your agent.

### Bun users

For one-off commands:

```bash
bunx rea-agents@latest setup
```

Bun global updates require Bun 1.2.17 or later.

### MCP schema configuration

REA supports configurable MCP input and output schema profiles.

For complete input guidance:

```text
REA_MCP_INPUT_SCHEMA_PROFILE=full
```

For compact output schemas:

```text
REA_MCP_OUTPUT_SCHEMA_PROFILE=compact
```

To omit advertised output schemas:

```text
REA_MCP_OUTPUT_SCHEMA_PROFILE=off
```

These settings affect advertised schemas; canonical server-side validation and structured results remain available.

See the MCP contracts guide for details.

## Supported Analysis

REA supports a broad range of targets and analysis workflows.

| Category | Supported targets |
|---|---|
| Desktop | Desktop installations and application components |
| Native | Native binaries, ELF, PE, Go and Rust binaries |
| GPU | CUDA, HIP, PTX and GPU code objects |
| Models | GGUF and safetensors |
| Game engines | IL2CPP metadata and Godot PCK |
| Apple | Apple application packages and IPS crash reports |
| Linux | Kernel modules, ELF notes and recorded crashes |
| Web | Websites, JavaScript and Electron applications |
| Managed code | .NET assemblies and CIL |
| Android | APKs, signatures, resources and connected devices |
| Mobile | Flutter applications |
| Firmware | Firmware regions and extracted files |
| Network | HAR, SAZ, PCAP and packet analysis |
| Hardware signals | Recorded logic signals |
| Databases | SQLite databases |
| Other | WASM, EVM bytecode, Erlang BEAM and PyInstaller executables |

Some workflows require external tools or specific operating systems.

For exact prerequisites and supported formats, consult the official documentation.

## Native Analysis Providers

Depending on the target and operation, REA can use:

- Hopper
- Ghidra
- IDA
- Kuna
- GNU objdump
- Rizin

Provider requirements and supported formats differ.

Some static analysis workflows do not require a native decompiler.

REA does not grant licenses for commercial third-party tools. You must obtain and use them under their respective licensing terms.

## Command Line Usage

Install the CLI:

```bash
npm install --global rea-agents
```

View available commands:

```bash
rea --help
```

Analyze a JavaScript/Electron application:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Update REA:

```bash
rea update
```

Build an RL environment from a recorded session:

```bash
rea environment-build ./session.har ./my-env --name my-env --json
```

Run the generated environment:

```bash
agent-env run ./my-env
```

Refer to the CLI and Evidence guide for command options, providers, snapshots, scripting, and result contracts.

## Showcases

REA includes practical reverse-engineering case studies.

### DX-Ball — Sound-pan reconstruction

Investigate a sound-position calculation, inspect its instructions, and reconstruct the behavior in C.

### Notion — Electron clipboard investigation

Trace the clipboard functionality through renderer, preload, IPC, and the main process.

### TH04 — DOS game reverse engineering

Investigate original 16-bit instructions and reconstruct a historical bullet-ring calculation.

### Reinforcement Learning environments

Transform recorded web application interactions into tools and reusable environments for AI-agent training and evaluation.

Explore more examples:

https://rea.tools

## Build RL Environments

REA can turn recorded API requests and responses into tools that an AI agent can use in a local environment.

This can help with:

- Reinforcement learning experiments.
- Agent evaluation.
- Reproducible application workflows.
- Testing supported operations.
- Building task-specific environments.

### Example agent prompt

```text
Use REA to build an RL environment from my test web app
at http://127.0.0.1:3000.

Cover listing, creating, renaming, and deleting folders.
You may create and remove test folders.
Leave existing data unchanged.

Save it in a folder named my-env.
Check which operations work and tell me how to run it.
```

### Build using the CLI

If you already have a recorded browser session:

```bash
rea environment-build ./session.har ./my-env --name my-env --json
```

Run it using AgentEnv:

```bash
agent-env run ./my-env
```

Running the exported environment also requires AgentEnv and Docker.

Official resources:

- https://rea.tools

## Privacy and Security

REA analyzes targets locally. The AI agent receives the tool results, and the model provider has its own data-handling policy.

Keep these points in mind:

- Only analyze software you own or have permission to examine.
- Review runtime operations before allowing them.
- Use trusted installation sources.
- Review configuration changes before approving them.
- Obtain third-party tools from their official sources.
- Follow applicable software licenses and security policies.

For vulnerability reporting, see:

https://github.com/morluto/rea/blob/main/SECURITY.md

## FAQ

### Which AI agents can use REA?

Any agent supporting local MCP servers can potentially use REA through manual MCP registration. The setup utility supports the agents listed in the installation documentation.

### Do I need a native analysis engine?

Not for every task. Static JavaScript and .NET inspection can work without a native analysis engine. Deep native analysis depends on the provider and target.

### Do I need to start Hopper manually?

REA can start Hopper when an operation requires it. A first-run activation or demo-mode prompt may need to be completed.

### Does REA upload my application?

REA analyzes targets locally. Your agent receives the results, and your model provider's data policy applies to those results.

### What does the REA skill do?

The skill provides investigation instructions to your agent. Registering the MCP server and installing matching instructions are handled through the setup process.

### What kind of output does REA provide?

Depending on the target, results can include pseudocode, assembly, metadata, module relationships, network observations, runtime evidence, and other structured findings.

### What should I do if something does not work?

First update REA:

```bash
rea update
```

Refresh agent setup:

```bash
npx rea-agents@latest setup
```

Restart your agent and retry.

If the problem continues, report it through GitHub Issues with:

- REA version.
- Operating system.
- Target type.
- Steps to reproduce.
- Relevant error output.

## Documentation

For complete technical details, refer to:

| Resource | Description |
|---|---|
| [REA Website](https://rea.tools) | Main project website |
| [GitHub Repository](https://github.com/morluto/rea) | Source code and releases |
| [Installation Guide](https://rea.tools) | Installation and setup information |
| [CLI and Evidence](https://rea.tools) | CLI workflows and evidence |
| [MCP Documentation](https://rea.tools) | MCP configuration and contracts |
| [Showcases](https://rea.tools) | Practical reverse-engineering examples |
| [Issues](https://github.com/morluto/rea/issues) | Bug reports and feature requests |
| [Contributing Guide](https://github.com/morluto/rea/blob/main/CONTRIBUTING.md) | Contribution instructions |
| [Security Policy](https://github.com/morluto/rea/blob/main/SECURITY.md) | Security reporting |

For exact commands and feature availability, use the documentation shipped with the current release.

## Community

Join the community, share your findings, ask questions, and learn from other developers.

- **GitHub:** https://github.com/morluto/rea
- **Issues:** https://github.com/morluto/rea/issues
- **Pull Requests:** https://github.com/morluto/rea/pulls
- **Website:** https://rea.tools

Community participation is welcome. Share useful investigations, report bugs, suggest improvements, and contribute documentation.

## Contributors

Thanks to everyone who helps improve REA through code, documentation, testing, feedback, and community support.

<p align="center">
  <a href="https://github.com/morluto/rea/graphs/contributors">
    <img src="https://contrib.rocks/image?repo=morluto/rea" alt="REA contributors">
  </a>
</p>

<p align="center">
  <a href="https://github.com/morluto/rea/graphs/contributors">
    View all contributors
  </a>
</p>

## Contributing

Contributions are welcome!

You can help by:

- Reporting bugs.
- Suggesting new features.
- Improving documentation.
- Fixing issues.
- Adding tests.
- Improving existing workflows.
- Sharing real-world use cases.

### Contribution workflow

1. Explore the existing issues.
2. Fork the repository.
3. Create a feature branch.
4. Make your changes.
5. Run the relevant checks.
6. Commit your work with a clear message.
7. Open a pull request with a detailed explanation.

Read the official contribution guidelines before submitting changes:

https://github.com/morluto/rea/blob/main/CONTRIBUTING.md

## Disclaimer

REA is intended for lawful research, education, interoperability, software preservation, and analysis of software you own or are authorized to examine.

Do not use REA for unauthorized access, illegal activity, or violation of third-party rights.

Read the full disclaimer:

https://github.com/morluto/rea/blob/main/DISCLAIMER.md

## License

REA-authored code is licensed under the **MIT License**.

Third-party materials retain their respective licenses and copyright notices.

See:

- [MIT License](https://github.com/morluto/rea/blob/main/LICENSE)
- [Third-party notices](https://github.com/morluto/rea/blob/main/THIRD_PARTY_NOTICES.md)

Commercial tools such as IDA Pro, Hopper, and JEB must be obtained and used under their respective licenses. REA does not provide commercial licenses, activation keys, or authorization to bypass licensing restrictions.

---

<p align="center">
  <strong>Understand the software. Follow the evidence. Build something better.</strong>
</p>

<p align="center">
  Made for developers, researchers, and reverse-engineering enthusiasts.
</p>

<p align="center">
  <a href="https://github.com/morluto/rea">⭐ Explore REA on GitHub</a>
</p>
