# Plan

Keep shape policy in the bundle analyzer. `webBundleEndpointLiteral` classifies
one exact string or expression-free template. `webBundleAnalyzerInspection`
records candidates after the existing request rules, using the traversal parent
for array elements and `const` initializers, and reads further ancestors only
for a URL-shaped initializer.

The candidate budget lives in the existing analysis-settings registry as
`web.bundle_endpoint_literal_candidates`, seeded by
`REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES`. The browser provider resolves the
accepted snapshot for the call and the worker request carries that ceiling.
Omission stays on the analysis result; it does not fail the script or raise the
worker result budget.

The browser guide describes the heuristic. This directory is the feature
record.
