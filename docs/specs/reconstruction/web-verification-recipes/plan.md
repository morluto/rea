# Implementation plan

1. Adapt the old domain comparisons, source provenance and web claim evaluators to the 6.9 domain owners. Reuse Evidence parsing and exact reference resolution; move the existing pure PNG comparison inward only where needed by verifier re-evaluation.
2. Compose web comparison Evidence in the application layer. Browser providers continue producing observations; deterministic comparisons no longer require a live browser provider. Keep named input/output contracts and exact MCP bindings.
3. Expose the existing finite evaluator as an offline CLI workflow taking specification and Evidence bundle. Share evaluator/error semantics with session-owned MCP; retain the current CLI JSON conventions.
4. Adapt complete recipes, generated prompt guidance, examples and focused acceptance tests to current contracts and documentation locations. Keep environment/AgentEnv instructions linked to their canonical owners.
5. Build once interfaces settle, run coordinated focused checks and executable examples, then independent review and necessary regression repeats.

Ownership: web-domain agent owns domain/browser comparison semantics, web input/output contracts, comparison application service/provider boundary and their tests. Recipe agent owns prompt recipe changes, documentation/guides, scripts/examples and recipe tests. Coordinator owns CLI/server composition, offline verification service, metadata/generated-output integration and integrated validation. Shared-file changes are coordinated explicitly. No agent writes another owner's files or runs broad expensive gates concurrently.

The previous 6.4 commits are reference material, not a branch to merge wholesale. Source clean at start; original branches/backups remain intact. No upstream push or human readiness assertion is part of this change.
