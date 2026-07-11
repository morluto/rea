---
name: better-binary-analysis
description: Analyze local binaries with Better Binary and Hopper through its MCP session workflow.
---

# Better Binary Analysis

Call `open_binary` with a readable local path before analysis. Begin with `binary_overview`, use strings and symbol searches to identify relevant procedures, then use `procedure_pseudo_code`, callers, callees, and xrefs to build evidence. Call `open_binary` again to switch targets and `close_binary` when finished. Never claim real-Hopper behavior from mock-only evidence.
