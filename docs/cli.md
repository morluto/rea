# CLI and Evidence

Use the CLI for a direct inspection or a script. It uses the same application
workflows and evidence contracts as REA's MCP server. Each CLI invocation is a
separate process; save results when you want to use them in a later command.

## Run a command

After [installing REA](installation.md), use `rea`. You can also run a command
without a global installation:

```bash
npx -y rea-agents@latest analyze-javascript-application /absolute/path/to/app --json
```

Use an extracted application directory or an ASAR as the target. Static
JavaScript analysis returns the application graph and Evidence directly.
Generic `rea analyze PATH` selects this workflow for directories and `.asar`
files when neither `--provider` nor `--snapshot` is supplied. See
[JavaScript artifact reconstruction](javascript-artifact-reconstruction.md)
for results, integrity checks and coverage.

## Native analysis

Configure [Hopper or Ghidra](installation.md#hopper), or the
[IDA adapter](ida-provider.md), before analyzing a native target. Substitute
your target, search text and function name or address in these examples:

```bash
rea analyze /absolute/path/to/program --provider ghidra --json
rea search /absolute/path/to/program "search" --provider ghidra --json
rea function /absolute/path/to/program main --provider ghidra --json
rea decompile /absolute/path/to/program 0x1000 --provider ghidra --json
rea xrefs /absolute/path/to/program 0x1000 --provider ghidra --json
rea trace /absolute/path/to/program "search" --provider ghidra --json
```

`analyze` and `inspect` share the native overview workflow. `function` returns
a function dossier; `decompile` returns pseudocode. For assembly instructions
alone, use `rea instructions`. A macOS `.app` bundle can be supplied directly.

Run `rea --help` or a command's `--help` for arguments and output options.
The [generated catalog](product-catalog.json) lists all CLI commands and MCP
tools. Provider-specific target support is described in the
[native guide](native-investigation.md), [DOS guide](ghidra-dos.md), and
[Windows Ghidra guide](windows-ghidra-p0.md).

## Choose a provider

List the available providers and their supported operations:

```bash
rea providers --json
rea capabilities --json
```

These commands describe binary-session providers and auxiliary capabilities.
For the complete MCP surface, use the connected server's tool list and the
session's advertised availability; individual guides describe prerequisites.

With automatic selection, REA uses the single available provider that supports
the target. When several providers support it, select one explicitly:

```bash
rea analyze /absolute/path/to/program --provider hopper
```

Set `REA_ANALYSIS_PROVIDER` for a standing preference. An explicit `--provider`
overrides it. In MCP, pass `provider_id` to `open_binary`:

```json
{
  "path": "/absolute/path/to/program",
  "provider_id": "hopper"
}
```

The selected provider remains bound to the session until an explicit switch
or close. Provider failures are returned with their original reason. For an
`ambiguous` selection error, choose from `details.candidate_ids`; for
`provider_unavailable`, run `rea doctor --provider ID --json` to diagnose the
selected engine. See [task readiness](installation.md#check-readiness-for-your-task)
and [provider selection](adr/0001-provider-selection-and-analysis-profiles.md).

The session reports work still in progress through `analysis_activity`.
A client timeout can end its wait while the provider continues analyzing.
`cleanup_incomplete` identifies resources whose shutdown or removal could not
be verified. See [MCP contracts](mcp-contracts.md) for session lifecycle and
[Ghidra first-query deadlines](mcp-contracts.md#ghidra-first-query-deadlines-and-recovery)
for import, client timeouts and recovery.

## Save and reuse analysis snapshots

A snapshot retains successful analysis results for later queries. REA reuses
an exact result when the target bytes, operation, parameters, provider and
settings match. Mutations and cursor-dependent calls are excluded from the
cache. Snapshot files are local and use owner-only permissions.

```bash
rea analyze /absolute/path/to/program --provider ghidra --snapshot /absolute/path/to/analysis/program.json
# Repeat the same query to reuse its saved result.
rea analyze /absolute/path/to/program --provider ghidra --snapshot /absolute/path/to/analysis/program.json
```

An exact CLI cache hit is read before starting a provider process.
In MCP, `open_binary` accepts `snapshot_path` to import a snapshot atomically
for its matching target; an MCP provider may still start before returning a
cached result. `close_binary` accepts `snapshot_path` and optional
`overwrite: true` to save before releasing provider resources. A failed save
leaves the session open so the caller can resolve the output failure.

The MCP save receipt reports `primitive_entries`, `workflow_entries`, and
`evidence_records` separately. Zero primitive bindings can still accompany retained workflow
results and Evidence. These are cached observations, not a saved provider
database: only eligible exact queries can reuse a result, and new or live
queries can still require provider startup. The CLI uses the same snapshot
format and preserves these records when loading and updating it.

## Import, export and compare Evidence

Evidence records retain artifact identity, source locations, observations,
inferences and unresolved findings. Validate an existing bundle, export its
canonical form, or compare two supplied bundles:

```bash
rea evidence-import /absolute/path/to/evidence/bundle.json
rea evidence-export /absolute/path/to/evidence/bundle.json /absolute/path/to/evidence/canonical.json
rea compare /absolute/path/to/evidence/left.json /absolute/path/to/evidence/right.json
```

Exports preserve an existing destination unless `--overwrite` is explicit.
For application traces and version comparisons, see
[JavaScript application workflows](javascript-application-workflows.md).
MCP [retained Evidence references](mcp-contracts.md#retained-application-evidence-inputs)
belong to one connection. Separate CLI calls consume full saved records.

## Import historical source

Import an older source tree to compare with the current artifact:

```bash
rea import-reference-source /absolute/path/to/source
```

The import records hashes and metadata for the supplied files, separately
from observations of the current app. File names do not automatically exclude
files. Set `REA_REFERENCE_SECRET_PATTERNS_JSON` to a JSON array of ignore
patterns when you want to exclude selected paths.

Historical-source import requires safe no-follow file opens on Linux or
macOS. Native Windows returns `unsupported_host`; use Linux REA inside WSL
or another supported host. See
[source-to-bundle comparison](javascript-application-workflows.md#historical-source-to-bundle-comparison)
for mapping identities, inferences and unknowns.

## Capture runtime behavior

Choose the guide for the target and intended interaction:

- [Browser observation](browser-observation.md): inspect a selected page through CDP.
- [Browser scenarios](browser-scenario-contract.md): run declared interactions and capture their results.
- [Electron observation](electron-observation.md): inspect an Electron renderer or capture an application scenario.
- [Node/Electron Inspector](javascript-runtime-observation.md): record script locations and execution contexts.
- [Process capture](process-capture.md): run an executable and compare terminal, exit and filesystem observations.

Runtime requests name the target and actions. Launched targets run with your
user permissions; consult the chosen guide for host requirements and effects.

## Output and exit status

The default terminal format is TOON. Use `--json` when saving results for a
JSON consumer. Output selection and formatting do not change operation status.

| Status    | Meaning                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | The operation completed. Its result may include partial evidence, warnings or unresolved questions.                                                  |
| `1`       | The operation could not complete. Structured output identifies invalid input, permissions, cancellation, timeouts or another failure when available. |
| `128 + N` | Signal `N` ended the process, where the shell or runtime preserves the conventional signal-derived status.                                           |

`setup --dry-run` returns `planned` and exits `0`; a cancelled setup also exits
`0`. Setup returns `1` for `needs_confirmation` or `needs_human`.
`doctor` returns `1` when required checks in its selected readiness scope fail;
unavailable optional providers remain informational for unrelated tasks.

Enable `pipefail` in a supporting shell so a downstream formatter preserves
REA's failure status:

```bash
set -o pipefail
rea inspect-artifact ./app.asar --json | jq . > inspection.json
```
