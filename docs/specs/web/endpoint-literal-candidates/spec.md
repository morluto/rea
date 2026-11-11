# Web bundle literal endpoint candidates

This specification records the literal inventory added for #3539. For current
behavior, see the
[browser observation guide](../../../guides/web/browser-observation.md).

## Problem

`analyze_web_bundle` kept request-shaped calls and some proven endpoints, and
dropped path or URL literals that appear as wrapper arguments, array elements,
or base-URL constants. An analyst then had to read the script to find those
strings, and a generated array of unique paths could fill the worker result
budget.

## Requirements

- Retain exact strings and expression-free templates that are nonempty
  root-relative paths (`literal:path-shaped`) or parseable absolute HTTP(S) or
  WS(S) URLs (`literal:url-shaped`).
- Discover them only as the first argument of a call the existing request rules
  did not classify, as a literal array element (including mixed arrays), or as
  the initializer of a `const` declaration. Absolute URL constants qualify;
  path-shaped constants do not.
- Keep each candidate a low-confidence `endpoint_candidate` inference. Do not
  record it as an endpoint observation. Reuse userinfo redaction, script and
  artifact provenance, and first-coordinate deduplication per script, value and
  detector.
- Keep the first source coordinate in source-tree order. A nested array element
  stays ahead of the same value in a later element.
- Exclude proven Map lookups, module loads and known browsing-context opens
  from the call fallback. Leave `analyze_javascript_application` unchanged.
- Bound the inventory with `web.bundle_endpoint_literal_candidates`. The launch
  seed is `REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES`: default 1024, floor 1,
  maximum 4096. Each `analyze_web_bundle` call reads the accepted runtime
  snapshot and sends that ceiling to the worker.
  `update_analysis_settings` changes the next analysis.
  `inspect_analysis_settings` lists the setting. A value outside the range is
  rejected and leaves the current ceiling unchanged.
- When further unique literals are omitted, `completeness.status` is `partial`
  and `endpoint_literal_candidates` names the setting, the effective count, the
  source (`default`, `setting` or `runtime`), the admitted and omitted counts,
  and the allowed range, with `update_mode: "runtime"` and
  `pending_restart: false`. A literal whose serialized record, including
  provenance, does not fit the remaining worker result budget is omitted
  instead of failing the script. When the effective count is already the
  maximum, `ceiling` is `maximal`: no accepted setting value reveals the
  omitted literals. The ceiling does not raise the worker result budget.
- Read the traversal parent that is already available. Copy the ancestor list
  only after a node is a URL-shaped variable initializer that still needs its
  grandparent.

## Acceptance

The #3539 fixture keeps the existing `http.post` candidate and `fetch`
observation, and adds the wrapper argument, the array entries and the absolute
base URL as low-confidence candidates. Map lookups stay excluded. A nested
repeat keeps the earlier coordinate. A ceiling of two path literals omits the
third, reports partial coverage, and still keeps an observed endpoint. A
runtime ceiling applies to the next analysis. A script whose only literal
candidates are array elements does not snapshot ancestors for the other nodes.

## Non-goals

No interprocedural resolution, constant propagation, dynamic string evaluation,
runtime reachability, or claim that an array is a route table. Local file paths
and configuration arguments may be candidates. No new tool, and no change to
request observations.
