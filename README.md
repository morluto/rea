
<!-- ================= HOW TO USE REA ================= -->

## 🚀 How to Use REA

REA can be used through an AI coding agent connected over MCP or directly through its command-line interface.

### 1. Install REA

Make sure Node.js and npm are installed.

```bash
node --version
npm --version
```

Install and configure REA:

```bash
npx rea-agents setup
```

Choose your preferred AI coding agent, review the proposed configuration changes, and approve the setup. Restart your agent afterward.

### 2. Connect Your AI Agent

REA supports agents that can connect to local MCP servers.

After setup, open your configured agent and verify that REA's tools are available.

For manual configuration, follow the [MCP Registration Guide](docs/installation.md#mcp-registry).

### 3. Start Your First Investigation

Ask your AI agent to investigate an application or software component.

**Example: Understand an application feature**

```text
Investigate how the search functionality works in this application.

Trace the relevant modules, functions, dependencies and execution flow.
Show the evidence supporting your findings.
Explain the implementation and identify any unknowns.
```

**Example: Analyze a JavaScript or Electron application**

```text
Use REA to inspect this application:

/absolute/path/to/application

Identify its modules, imports, source maps, routes,
Electron IPC boundaries and native add-on relationships.

Explain the application's architecture and provide
evidence for the findings.
```

**Example: Analyze a native binary**

```text
Use REA to investigate this binary:

/absolute/path/to/program

Inspect its functions, strings, symbols, references,
assembly and available pseudocode.

Explain the important functions and show the
evidence behind your conclusions.
```

Configure an appropriate native analysis provider before requesting deep native analysis.

**Example: Analyze a website**

```text
Use REA to inspect my authorized test website.

Analyze its page structure, scripts and network behavior.
Identify important application components and explain
how the requested feature works.
```

Use the browser analysis workflow and a supported Chrome-family browser.

### 4. Analyze Using the CLI

REA also supports direct terminal workflows.

For JavaScript and Electron applications:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

For available commands:

```bash
rea --help
```

For native analysis, provider selection, snapshots and scripting, see the [CLI and Evidence Guide](docs/cli.md).

### 5. Understand the Results

When an investigation finishes:

1. Review the returned findings.
2. Examine supporting evidence and references.
3. Follow relevant functions and dependencies.
4. Identify limitations and unanswered questions.
5. Ask follow-up questions when additional investigation is needed.
6. Use the findings to implement and test your own solution.

Do not treat an inference as a confirmed finding when supporting evidence is unavailable.

### 6. Keep REA Updated

For a global installation:

```bash
rea update
```

For an npx-based installation:

```bash
npx rea-agents@latest setup
```

Review configuration changes and restart your agent.

See [Installation and Setup](docs/installation.md) for complete instructions.

> **Important:** Only analyze software, binaries, devices and systems that you own or are authorized to examine. Runtime investigations may execute or interact with the selected target using your user permissions.

---

<!-- ================= COMMUNITY ================= -->

## 🌐 Community

Join the REA community and connect with developers, researchers and reverse-engineering enthusiasts.

| Platform | Link |
|---|---|
| 🌍 Official Website | [rea.tools](https://rea.tools/) |
| 💻 GitHub Repository | [morluto/rea](https://github.com/morluto/rea) |
| 💬 GitHub Discussions | [Discussions](https://github.com/morluto/rea/discussions) |
| 🐛 GitHub Issues | [Issues](https://github.com/morluto/rea/issues) |
| 🎮 Discord Community | [Join Discord](https://discord.gg/GkcryMnJDM) |
| 📚 Documentation | [Official Guides](https://rea.tools/guides/) |
| 🔍 Showcases | [Explore Showcases](https://rea.tools/showcase/) |
| 📦 npm Package | [rea-agents](https://www.npmjs.com/package/rea-agents) |

Have an interesting reverse-engineering use case?

Share your experience, ask questions, report bugs or contribute improvements to the project.

**Let's make reverse engineering more accessible through AI and open source!**

---

<!-- ================= CONTRIBUTORS ================= -->

## 👥 Contributors

REA is built and improved through the contributions of developers, reverse-engineering enthusiasts, researchers and open-source community members.

We appreciate everyone who contributes code, documentation, testing, bug reports, feature ideas and technical feedback.

### Our Contributors

<a href="https://github.com/morluto/rea/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=morluto/rea" alt="REA Contributors" />
</a>

### Become a Contributor

Want to contribute to REA? There are many ways to get involved:

- 🛠️ Fix bugs and improve existing functionality.
- 🔬 Add support for new file formats and analysis workflows.
- ⚙️ Improve CLI and MCP functionality.
- 📖 Write documentation and practical examples.
- 🧪 Add tests and improve project reliability.
- 💡 Report issues and suggest new features.
- 🔧 Submit pull requests with improvements.

Every meaningful contribution helps make REA better for the entire community.

### Contribution Links

- [View All Contributors](https://github.com/morluto/rea/graphs/contributors)
- [Contribution Guidelines](CONTRIBUTING.md)
- [Open an Issue](https://github.com/morluto/rea/issues)
- [Submit a Pull Request](https://github.com/morluto/rea/pulls)

---

<div align="center">

### ⭐ Support Open Source

If you find REA useful, consider giving the repository a star on GitHub.

Your support helps the project grow and encourages more developers to contribute.

**Explore. Investigate. Understand. Reconstruct.**

Made for the reverse-engineering and open-source community ❤️

[![GitHub Stars](https://img.shields.io/github/stars/morluto/rea?style=social)](https://github.com/morluto/rea/stargazers)
[![GitHub Forks](https://img.shields.io/github/forks/morluto/rea?style=social)](https://github.com/morluto/rea/network/members)

</div>
