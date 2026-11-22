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

See [installation and setup](getting-started/installation.md) for requirements and configuration.

For runtime instrumentation, see the [Frida guide](guides/runtime/frida-instrumentation.md).

## Choose a guide

- [Inspect an installation directory](desktop-applications.md) to identify its
  runtime and choose the next files to examine.
- [Investigate a native binary](guides/native/native-investigation.md) or
  [choose a provider](README.md#provider-setup-and-formats) for your host and target.
- [Analyze JavaScript or Electron artifacts](guides/javascript/javascript-artifact-reconstruction.md)
  or [relate static findings to runtime observations](guides/javascript/javascript-runtime-reconciliation.md).
- [Observe a website with CDP](guides/web/browser-observation.md) or
  [inspect an existing network capture](guides/web/web-network-captures.md).
- [Build an agent environment from a recording](agent-environments-quickstart.md)
  or [capture a Linux desktop application](desktop-application-capture.md).
- [Use the CLI and retain Evidence](getting-started/cli.md) or
  [look up MCP result and session contracts](reference/mcp-contracts.md).
- [Report a PE overlay](pe-overlay.md) to see where a Windows image ends on
  disk and what follows it.

Browse the [documentation directory](README.md) for formats, provider
prerequisites, and contributor references.

![REA inspecting a native binary in Hopper](./assets/rea-hopper-analysis.png)
