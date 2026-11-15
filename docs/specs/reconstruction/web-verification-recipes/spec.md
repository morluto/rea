# Web reconstruction verification and complete recipes

Status: implemented and verified on REA official 6.9.0 (`d74549e495c58eb4a560279fd9f05508401ea0a0`).

## Problem and outcome

REA compares browser observations and PNGs, but its finite reconstruction verifier cannot consume them. Its existing verifier is MCP-only. Adapt the preserved reconstruction work to the released architecture, exposing one evaluator through CLI/MCP and complete reproducible web/CLI investigation and reconstruction recipes.

## Requirements

- R1: Extend existing web comparators with authenticated left/right Evidence, inline or through exact supported references, while retaining detached value comparison. A detached comparison never qualifies as reconstruction proof.
- R2: Bind comparison identity, normalized input policy, source type and complete source closure. Verify source integrity and compare exact admitted source facts. Preserve caller URLs, paths, IDs and explicit uncertainty.
- R3: Add finite web-capture, web-scenario and web-screenshot claims to the existing verifier. Behavior, structure and pixel policy remain separate. A missing step, incomplete capture, ambiguous correspondence or insufficient authority cannot pass; independent observed differences may fail.
- R4: Provide `rea verify-reconstruction <request.json> --json` accepting specification plus canonical Evidence bundle and the same semantics as MCP's session-owned verifier. CLI expected failures retain tagged errors and actionable diagnostics.
- R5: Provide complete investigation → reconstruction → comparison → correction → finite verification web and CLI recipes, rendered through existing guided workflows. Include executable CLI/MCP examples with explicit source IDs, policy, coverage, unknowns and closure.
- R6: Tests cover public adapter handoffs, source tampering/closure, retained/inline inputs, original claim regressions, visual/behavior separation and malformed inputs. Validate generated SDK schemas and relevant docs.

## Invariants and boundaries

No new analysis provider, arbitrary target execution interface, agent launcher, visual design extraction, noise masking or automatic update behavior. Examples exercise existing capture authority against owned fixtures only. New process capture remains Linux/macOS; Windows can compare and verify retained captures. Preserve all 6.9 provider admission, resource bounds, exact selected inputs and lossless observations. The canonical global skill remains the only active shared installation; any authored skill source stays disabled for discovery.

## Acceptance

- Complete web scenario and PNG claims return the expected pass/fail/unknown with source closure through CLI and MCP.
- Tampered sources, absent source closure and incompatible comparisons cannot pass.
- Detached comparisons continue returning useful deltas without proof authority.
- Existing process/function/artifact specifications retain their behavior and coverage.
- CLI and MCP examples run reproducibly, including a failing reconstruction and an incomplete-evidence result; recipe examples perform a meaningful correction.
- Build, relevant focused tests, fast checks, schema/documentation checks and independent review are recorded with actual limits.
