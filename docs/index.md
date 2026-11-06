---
layout: home

hero:
  name: REA
  text: Reverse Engineer Anything
  tagline: Understand binaries, applications, and runtime behavior with one CLI and MCP server.
  actions:
    - theme: brand
      text: Get started
      link: /installation
    - theme: alt
      text: View on GitHub
      link: https://github.com/morluto/rea

features:
  - title: Investigate with your agent
    details: Connect REA to your coding agent, describe the app or feature you want to understand, and follow the evidence.
    link: /mcp-prompts
  - title: Inspect across formats
    details: Explore native binaries, JavaScript and Electron apps, .NET assemblies, Android packages, firmware, and websites.
    link: /installation
  - title: Keep the evidence
    details: Analysis runs locally and returns observations, limitations, and unknowns through the CLI and MCP.
    link: /mcp-contracts
---

## Start with one command

```bash
npx rea-agents setup
```

Choose your agent, review the planned changes, and approve setup. Native binary
analysis can use an existing Hopper, Ghidra, or IDA installation; static
JavaScript analysis needs no native analysis engine.

For a first result from an extracted JavaScript application or ASAR:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

See [installation and setup](./installation.md) for requirements and configuration.

For runtime instrumentation, see the [Frida guide](./frida-instrumentation.md).

## Choose a guide

| Export a captured application as an environment     | [Desktop application export](desktop-application-export.md)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Write and validate a task for an exported app       | [Desktop application tasks](desktop-application-tasks.md)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Drive a computer while building an environment      | [Desktop build computer](desktop-build-computer.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Use CLI/MCP and retain evidence                     | [CLI](cli.md), [MCP contracts](mcp-contracts.md), [agent prompts](mcp-prompts.md), [obligation ledgers](reconstruction-obligation-ledgers.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

For development, use [testing](testing.md), [client verification](client-verification.md),
[tool design](tool-design.md), [admission limits and recovery](design/limits-and-recovery.md),
and [releasing](releasing.md).
[Reconstruction readiness](reconstruction-readiness.md) describes a development
conformance verifier. [The 6.2 migration](migration-6.2.md) records that release's
compatibility changes; [the roadmap](roadmap.md) tracks future work.

![REA inspecting a native binary in Hopper](./assets/rea-hopper-analysis.png)
