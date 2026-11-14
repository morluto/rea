# Android UI implementation plan

This review-time plan records the current approach and remaining integration
gates; it does not invent a pre-implementation approval. Requirements are owned
by the [specification](spec.md), and current verification by [tasks](tasks.md).

## Boundaries

1. **Contracts (R2–R5):** named domain schemas own selectors, scope, snapshot and
   node facts. Public contracts bind only observation operations. The proposed
   action contract is bound explicitly by the unshipped source-tree experiment.
2. **Producer (R1, R3–R5, R7):** an operator-owned Android instrumentation runner
   captures bounded package-scoped accessibility snapshots. Protocol v2 controls
   prepare/status/cancel/forget over short broadcasts; request bodies use a
   private stdin/socket channel. The operator retains runner lifetime authority.
3. **Transport owner (R3, R5–R7):** `AdbUiRunner` admits one request identity,
   validates completed observations before classifying them as known reports,
   and reuses those parsed facts for delivery and cleanup recovery. Definitive
   refusals, validated reports and unavailable results stay distinct.
4. **Application lifetime (R6):** `AdbProvider` serializes device operations and
   reconciles prior UI work before later device dispatch. Local availability
   probes have separate admission ownership; shutdown joins both lifetimes.
   Shared process and artifact owners retain cleanup and completed outcomes.
5. **Evidence and adapters (R2–R7):** CLI/MCP share application semantics.
   Completed or recovered facts retain controlled-replay provenance. Unknown
   action outcomes remain explicit warnings, not successful reports or retry
   permission. Retained paging never silently recaptures another snapshot.

## Verification sequence

Use source contracts and controlled provider-boundary regressions first, followed
by public CLI/MCP scenarios and failed-cleanup retry. Exercise source-tree fixture
ownership independently of Android behavior. Then run explicitly scoped real
Android and native-host checks; preserve unavailable coverage as unverified.

## Remaining gates

Do not register or distribute the proposed mutation capability without a linked
maintainer scope decision and its required verification. Passing CI, a written
plan, or a successful fixture run does not supply that authority. Human review
and ownership of the final diff remain separate from automated validation.
