# Single-file JavaScript application analysis

## Problem and outcome

`analyze_javascript_application` (`rea analyze-javascript-application`) previously
accepted only directories and `.asar` archives, rejecting standalone bundled or
authored JavaScript and TypeScript files (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`,
`.tsx`, `.mts`, `.cts`) with `AnalysisUnsupportedTargetError` unless the caller
copied the file into a temporary directory. Admit standalone JavaScript and
TypeScript source files directly under `format: "auto"` and `format: "file"`,
authenticated by canonical file identity and paired with exact single-file
runtime location reconciliation.

## Requirements

- **R1 — Single-file format admission and rejection**: Extend input `format`
  (`--artifact-format`) to `["auto", "asar", "directory", "file"]` and output
  `format` to `["asar", "directory", "file"]` across
  `javascriptApplicationAnalysisResultSchema`, `analysisViewResult`, and
  `javascriptRuntimeReconciliationSchemas`, while rejecting contradicting
  explicit `format` selections with `AnalysisInputError` (`invalid_request`),
  non-JavaScript extensions with `AnalysisUnsupportedTargetError`
  (`unsupported_target`), and disguised binary containers (`Mach-O`, `ELF`,
  `PE`, `ZIP`) via canonical `"javascript-bundle"` root-format checks.
- **R2 — Canonical single-file inventory and source identity**: Read admitted
  single-file targets through `SingleFileJavaScriptArtifactReader` with
  `assertArtifactSelectedSource` identity verification, map the root `"."`
  inventory occurrence to its normalized basename, preserve symlinked `.jsx`,
  `.ts`, `.tsx`, `.mts`, and `.cts` extension classification, and support
  `source_paths` filtering against that single normalized filename.
- **R3 — Exact-file runtime reconciliation confinement**: Map exact runtime V8
  Inspector / Electron script locations to `format === "file"` static `Evidence`
  layers automatically in `reconcile_javascript_runtime` without authorizing
  sibling files in the parent directory or external relative module imports.
- **R4 — Generic binary routing preservation**: Keep `namedArtifactFormat` and
  `rea analyze <file.js>` target routing unchanged; standalone single-file
  JavaScript application analysis is selected through
  `rea analyze-javascript-application` (`--artifact-format auto|file`) and
  `analyze_javascript_application` (`format: "auto" | "file"`).

## Acceptance

- **R1 & R4**: Verified by
  `tests/boundary/filesystem/javascriptApplicationInputSelection.test.ts`
  (disguised Mach-O `.js` rejection, `.bin`/`.png` `unsupported_target`
  rejection, and all six contradicting explicit `format` combinations) and
  `tests/boundary/cli/githubActionsExample.test.ts` (single-file `index.js`
  admission alongside `package.json` `unsupported_target` rejection).
- **R2**: Verified by
  `tests/boundary/filesystem/javascriptSingleFileAndTimeoutPolicy.test.ts`
  (standalone `.js` and `.mjs` `Evidence` authentication, `route_inventory` and
  `semantic_graph` projection, symlinked `.tsx` classification, and
  `source_paths` validation) and
  `tests/acceptance/applications/javascriptAnalysisLimits.test.ts` (CLI
  `--artifact-format file` and MCP `detail: "summary"` parity).
- **R3**: Verified by
  `tests/boundary/filesystem/javascriptSingleFileAndTimeoutPolicy.test.ts` and
  `tests/boundary/filesystem/javascript-applications/javascriptRuntimeReconciliation.test.ts`
  (exact-file V8 Inspector location matching on standalone and symlinked
  single-file layers while excluding sibling scripts and relative imports).

## Out of scope

Changing `rea analyze <path>` target routing to dispatch JavaScript application
analysis, executing target JavaScript, or implicitly scanning parent
directories when a single file is supplied.
