# Repository Guidelines

## Product and Authority

REA is a local-only reverse-engineering tool with shared CLI/MCP workflows. Distinguish observations, derivations, inferences, and unknowns; preserve Evidence provenance and session semantics through both adapters. Provider support and setup live in [README.md](README.md#choosing-a-deep-analysis-provider) and its linked guides.

Follow the [contribution scope](CONTRIBUTING.md#contribution-scope) and [fail-closed integration rule](CONTRIBUTING.md#fail-closed-integration), including the maintainer scope decision required before substantial implementation of a new provider or of target execution, injection, mutation, or protection recovery.

Ghidra uses ephemeral databases without modifying executable bytes or controlling a GUI; Windows Ghidra P0 has no mutation authority. IDA analysis is read-only; never save or close an attached GUI database.

Configuration changes must be additive and idempotent, with backups. Installers must not install or upgrade unrelated software, including Homebrew, Node.js, npm, Java, or Ghidra; Ghidra and IDA are bring-your-own. `rea setup` must show its planned changes and require approval before writing files or installing Hopper.

Preserve caller-selected inputs and local evidence, including output, URLs, paths, digests, and metadata. Redact transport authentication credentials and explicitly marked sensitive values; do not infer secrecy from names or text patterns. Do not persist the ambient environment merely because a child inherits it.

## Architecture and Cleanup

Dependencies flow inward: domain semantics and contracts, provider adapters, shared application workflows, then CLI/MCP adapters. Keep engine protocols and provider-specific code out of domain/application layers. Read the relevant wiring in `src/composition/` when changing composition.

Give each interpretation and resource a clear owner. Consumers must use that owner's parsed facts rather than reinterpret raw source. Preserve identity, omission, uncertainty, and source evidence across boundaries. Retain ownership of resources whose cleanup failed. Reuse `src/process/` supervision and identity primitives; a PID and executable path alone do not establish ownership after exit or reuse.

Keep proof of ownership separate from validity, editability, and readiness. Malformed owned data may still be safely removable. Unresolved identity or applicability must remain unknown rather than be treated as absent, foreign, or aligned.

For lifecycle changes, follow [ownership and completion invariants](docs/development/tool-design.md#own-the-lifecycle) and select the applicable [lifecycle regressions](docs/development/testing.md#lifecycle-regressions). Include late handshakes, cancellation during final cleanup, mixed child outcomes, and cleanup retry where those stages exist; active-execution cancellation alone does not cover finalization.

Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain its concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.

Whenever you implement, debug, review, or maintain code, check what you touch for brittleness: duplicated decisions, unclear ownership, and assumptions about state or lifecycle. Trace affected behavior through its consumers, and fix the producing representation or ownership rule before adding downstream repairs. When interpreting formatted input, [normalize once at the owning boundary using a format-aware parser](docs/development/tool-design.md#interpret-boundary-facts-once).

Include directly related refactoring in the fix; passing regressions alone cannot establish that the root cause is gone. After verifying affected consumers, remove superseded representations, aliases, wrappers, and redundant tests. Introduce abstractions only when they remove observed complexity. Explain any remaining cleanup and why it remains.

Check sibling paths for the same failure, verify suspected matches with working controls, and group findings by root cause. Before resolving a review thread, explain the root cause, structural fix, validation, and any remaining cleanup.

Parse unknown boundary values and model expected failures with the tagged error algebra and `Result`. Preserve partial facts and meaningful failure reasons. Keep identity and lookup values separate from display formatting; preserve source values and explicit unknowns when normalization loses information. Absolute paths, file URLs, and HTTP paths have different semantics.

Validate advertised JSON Schemas after SDK conversion against their declared dialect and actual clients. Bind handlers to named contracts with exact types; catalog ordering must never select an operation or schema.

## Performance

Design analysis workflows and agent interfaces for efficiency from the first implementation. Correctness, useful answers, Evidence provenance, caller choices, compatibility and safe resource bounds remain required.

Optimize in this order:

1. Agent tokens and context. Return the smallest sufficient answer with necessary provenance, coverage and limitations. Use task selection, summaries, paging and retained Evidence where supported; honor requested detail and keep complete Evidence accessible. Count the whole task, including schemas, extra calls and retries.
2. Analysis time. Reuse validated results and shared work. Cache keys must cover result-affecting inputs; define invalidation and lifetime. Validate freshness before reporting cached live state as current.
3. CPU and memory. Avoid unnecessary work and copies; bound concurrency, retained state and serialization growth.

Measure performance only for changes that target it or have a concrete regression concern. Routine cleanup, including changes to helper calls, imports, or representations alone, uses correctness checks, not synthetic benchmarks. When measurement is warranted, measure representative completed tasks and compare equivalent workflows before and after where available. Report token usage, elapsed time, CPU time and peak process-family memory. Separate cold and warm runs, label estimates, and state unmeasured costs. Fewer bytes alone do not establish fewer tokens or faster analysis.

## Development

Treat code as the source of truth for implemented behavior and architecture. Keep specs, implementation plans, task lists, ADRs, and architecture diagrams in issue or pull request discussions or in local drafts outside Git. Use the [documentation directory](docs/README.md) and [authoring guide](docs/development/documentation.md) for guides and references.

Use the toolchain pinned in [.nvmrc](.nvmrc) and `package.json#packageManager`. Cursor Cloud may place an older Node.js first on `PATH`; its environment setup installs the pinned toolchain under `/usr/local/bin`, so prefix `PATH="/usr/local/bin:$PATH"` before `node` and `npm`.

- `npm ci`: install locked dependencies.
- `npm run build:cached`: build the runtime and packaged skill.
- `npm run test:local -- PATH...`: source tests without building.
- `npm run test:focused -- PATH...`: exact tests with their required artifacts.
- `npm run check:fast`: cached typecheck and lint, plus architecture guards.
- `npm run docs:check`: validate generated documentation.

Run the checks relevant to the change; the complete local gate, `npm run check:pr`, is optional for broad changes or CI diagnosis. [CONTRIBUTING.md](CONTRIBUTING.md) covers development, generated-file ownership, and release conventions. When changing installers or setup recovery, follow [Checking installers and publisher downloads](docs/development/testing.md#checking-installers-and-publisher-downloads).

Coordinate expensive checks across agents. If a test unexpectedly consumes heavy CPU, stop its owned process family and profile a bounded representative case before retrying. Inspect production work, fixture generation, subprocesses, and repeated setup; preserve regression coverage when optimizing. Follow the [test resource guidance](docs/development/testing.md#developer-commands).

`docs/public/product-catalog.json`, `docs/verification/managed-conformance-*.json`, and `skills/` are ignored outputs. Edit source contracts and `.agents/skills/reverse-engineer-anything/`, then regenerate as needed. Never commit binaries, provider project documents, credentials, `dist/`, `node_modules/`, or local planning artifacts.

## Tool and Test Changes

For tool design, follow [docs/development/tool-design.md](docs/development/tool-design.md): start from the analyst question, reuse existing contracts, preserve caller choices, and return useful evidence inline. Admission limits, which refuse or stop work, must follow real format, protocol, authority, or resource constraints; delivery budgets size inline output for the consumer, never refuse, and keep the complete result retrievable. Account for representation expansion before allocation; derive completeness from examined coverage.

Choose the scope of a new limit from [analysis settings, limits, and recovery](docs/reference/limits-and-recovery.md). A registered runtime setting may have an optional launch seed; per-call and launch-only controls have their own contracts. Report the effective limit and recovery for the control that stopped the work. For changes that apply at runtime, document the setting ID and `update_analysis_settings`.

For user- or agent-facing tool problems, fix the owning behavior, contract, and actionable result or recovery at the point of use first. Document the result in product docs when explanation is needed. Add skill guidance only for workflow judgment or context that the tool cannot reasonably convey; a skill is not the primary repair for a discoverability or contract defect.

For test changes or provider claims, use [docs/development/testing.md](docs/development/testing.md). Select applicable [boundary regressions](docs/development/testing.md#boundary-regressions) for parser, inventory, snapshot, and projection fixes. Prefer real public CLI/MCP workflows, then production-boundary integration, then producer goldens. Keep module tests for distinct semantics stronger workflows cannot reliably reproduce. Preserve malformed-input, cancellation, cleanup, permission, capacity, and target-identity coverage when pruning. Report unverified coverage explicitly; simulated providers do not establish real-provider behavior.

Test behavior through structured facts, and assert wording when it is part of the contract. Follow [test design and pruning](docs/development/testing.md#test-design-and-pruning) and use the [supervised command owner](docs/development/testing.md#verifier-scripts) for commands launched by a verifier.

## Issues and Pull Requests

Follow the [issue reporting guidance](CONTRIBUTING.md#reporting-issues) and the matching issue form, and the [pull request ownership and readiness rules](CONTRIBUTING.md#pull-request-ownership-and-readiness). Use Conventional Commit subjects and PR titles as specified there, and mark breaking changes with `!` or a `BREAKING CHANGE:` footer. Describe behavior changes, relevant validation, and real-provider verification scope. Leave human readiness declarations to the human owner.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
