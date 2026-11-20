# Verification after upstream integration

Integrated upstream c462a4ebd, preserving its new signal-recording guide, managed
summary documentation, current translations and unknown-head pagination contract.

- Documentation facts and README consistency checks passed.
- Production VitePress build passed.
- Independent built-HTML verification passed for 57 stable public routes,
  56 physical source-edit links and 507 distinct internal file/anchor targets.
- The new regression caught a doubled catalog base path and a missing historical
  managed/native fragment. Both were corrected without weakening assertions.
- All six static tasks and architecture guards passed.
- 167 relevant catalog, release, documentation, signal-MCP, target-framing,
  managed-summary, Worker-URL CLI and CI-planner regression tests passed across
  ten files. CLI runs need process-table access for actual ownership/cleanup
  verification; restricted execution failed with spawn EPERM, while the normal
  host run passed without changing timeouts or assertions.
- After the subsequent upstream advance, 14 tests across unknown-head pagination,
  workflow replay and target-content framing passed. Static checks, documentation
  facts and all 57 published routes passed again against that base.
- Documentation CI and the manual build require the built-page verifier.
  An actual CI-planner regression ensures edits to the verifier select that lane.

The renderer treats physical docs/public references as site-root assets.
The managed guide retains its original heading and an explicit historical fragment
alias. External HTTP targets were not fetched; this verification concerns actual
local production HTML and source files.

The HTTP/3 lab was added to the documentation directory, navigation, and the
independent route baseline. The built-HTML verifier passed for 58 stable routes,
76 HTML pages, 74 physical edit links, and 627 distinct local targets or anchors.
The documentation and translated README consistency checks also passed.
