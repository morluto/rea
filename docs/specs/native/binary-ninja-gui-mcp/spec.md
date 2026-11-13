# Binary Ninja GUI MCP provider

Proposal: [#1551](https://github.com/morluto/rea/issues/1551) and [PR #5794](https://github.com/morluto/rea/pull/5794).

## Problem and outcome

Analysts with an executable already open in Binary Ninja need to use REA's
native analysis tools without starting another engine. Add an optional
`binary-ninja` provider for the built-in GUI MCP server in Binary Ninja 6 or later.

## Requirements

- Use an explicit local HTTP registration and check its syntax in doctor without
  connecting to the GUI. Keep authentication values out of diagnostics.
- Bind observations to the selected PE, ELF, or thin Mach-O executable. Check
  the digest of the Raw view before and after reading analysis results.
- Expose procedure and string inventories, searches, pseudocode, assembly,
  instructions, callers, callees, references, and the function dossier through
  the existing CLI and MCP contracts. Preserve incomplete coverage and partial
  evidence.
- Bound reads, pagination and search work. Respect caller cancellation and
  preserve failures recorded before cancellation.
- Select the target view for analysis and attempt to restore the prior shared
  selection on close. Keep this GUI side effect visible in the provider guide.

## Acceptance

Fixture tests cover registration, identity, pagination, errors, cancellation and
selection restoration. The live verifier checks CLI/MCP parity, target bytes,
function switching and selection restoration. Record the revision, host,
Binary Ninja version and input for live runs and distinguish them from fixture
coverage.

## Out of scope

Headless Binary Ninja is a separate proposal ([#7041](https://github.com/morluto/rea/pull/7041)).
The GUI adapter has no authority to launch targets, patch bytes, modify analysis
databases or run scripts in Binary Ninja.
