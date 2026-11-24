# Attribute captured website code

Use this workflow to locate original source or module relationships for one
selected captured script. Start with a concrete question, such as which original
source contains a reported callback, or which captured module could satisfy its
import. Source association, execution coverage and feature causality are separate
claims. A plausible filename or matching URL is not a source identity.

## Select and export the retained source

Start with the existing capture and its Evidence ID. If source bytes are missing,
follow [runtime observation](runtime-observation.md) to discover the selected
page with `list_browser_targets` and request `inspect_web_page` with
`include_script_sources: true`. For example, after selecting the actual target:

```json
{
  "cdp_endpoint": "http://127.0.0.1:9222",
  "target_id": "TARGET_ID_FROM_LIST_BROWSER_TARGETS",
  "include_script_sources": true
}
```

Save the complete Evidence from MCP `structuredContent`, or its normalized
result, as UTF-8 JSON. `export_web_scripts` accepts only saved `inspect_web_page`
or `capture_browser_scenario` captures; other browser operations, such as
`observe_web_execution` or `inspect_web_event_listeners`, are rejected. A
`capture_browser_scenario` reply delivered with `detail: "summary"` is a view, not
the capture, so save a complete capture. An existing scenario must have selected
`capture.network.response_body`; do not start browser actions merely to fill
this gap. Keep the recorded capture coverage and source-body limitations.

Call `export_web_scripts` with an absent output directory whose parent exists:

```json
{
  "capture_path": "/analysis/capture.json",
  "output_directory": "/analysis/exported-scripts"
}
```

Use the returned `manifest.path`, and select a zero-based index in `scripts`, not
a CDP script ID. For each candidate, check `content.state` and, when exported,
`content.sha256` and `content.bytes`. Read its identity from `source`:
`script_key` and `frame_id` for a page script, or `transaction_id`,
`request_sequence` and `response_sequence` for a scenario response. Preserve
`source_evidence_id`, `capture_sha256` and the manifest digest in the evidence
chain. Entries that share a URL remain separate candidates.

Scenario bytes come from Playwright's `Response.body()`, which can load the
request URL again with credentials when CDP has no body. Transaction and event
references therefore do not verify that those bytes came from the original
network transaction. Keep this
[source-body limitation](https://github.com/morluto/rea/blob/main/docs/guides/web/website-script-export.md)
with any claim about the exported bytes.

If `analysis_input` is not null, pass that object to
`analyze_javascript_application` when local file or module inventory is needed.
That analysis describes the exported files; its filesystem resolution cannot
establish browser import-map behavior. If `analysis_input` is null, stop static
analysis and report the unavailable source reasons from the manifest. Export
does not fetch or execute assets.

## Map one generated point to original source

Choose a local source-map file explicitly. A `source_map_url` declaration alone
does not supply its bytes or establish that it matches the deployed script. Do
not fetch the declaration automatically. With a selected map and exported script,
call `trace_web_source_location`:

```json
{
  "manifest_path": "/analysis/exported-scripts/manifest.json",
  "script_index": 0,
  "source_map": {
    "path": "/analysis/app.js.map",
    "url": "https://example.test/maps/app.js.map?v=7#context"
  },
  "generated_position": { "line": 1, "column": 25 }
}
```

Replace the example index and point with the selected entry and known position.
The map URL is a name-resolution context, not a fetch request. The operation
verifies the manifest, script and map bytes; the map pairing remains
caller-selected. If only a local map is available, its absolute file URL, such
as `file:///analysis/app.js.map`, supplies local resolution context. Report the
deployment URL as unknown; local resolution does not recover browser source URLs.

Complete delivery returns raw map text and embedded source content. For a large
map, add `detail: "summary"` to retain the complete parent and receive point
metadata only. Page further matches with `inspect_analysis_view` and
`view: {kind: "source-location", collection: "matches"}`, and read a bounded text
snippet with `collection: "source-text"` and a `match_index`. A refusal names the
exhausted `source_map_limits` field or `decode_timeout_ms`; retry with the same
manifest, map and point and only that control changed. See
[source locations](https://github.com/morluto/rea/blob/main/docs/guides/web/web-source-location.md)
for the budgets.

Lines here are one-based and script-relative; columns are zero-based UTF-16.
Runtime callsite and listener `line_number`/`column_number` values are CDP's
zero-based coordinates in the enclosing resource named by `url`. For a runtime
callback or request location, retain the session `script_id`, source digest and
`resource_start` when available. Separately captured matching text establishes
byte correspondence, not the same runtime instance; do not join captures by
script ID or URL alone.

- External script, or an empty-`script_id` initiator position in a script file:
  use `line_number + 1` and keep the column.
- Inline script with a `script_id` and known `resource_start`: use
  `line_number - resource_start.line_number + 1`. Subtract
  `resource_start.column_number` only on that first resource line; keep later
  columns unchanged.
- An empty-`script_id` position has no session-script association, so it cannot
  be joined to captured source or `resource_start`. Missing columns or an
  unknown inline start leave the conversion unknown.

See [coordinate semantics](https://github.com/morluto/rea/blob/main/docs/guides/web/web-runtime.md)
before transferring a runtime point.

Read `lookup.matched_generated_position` and every `matches` entry. Lookup uses
the greatest generated position at or before the request, including earlier
lines; it is not necessarily an exact-point match. Keep generated-only segments,
duplicate sources and indexed-section identities. An original position outside
embedded text has a null offset. `sourcesContent` hashes identify the map's
embedded text, not an independently captured original file. A mapped point does
not establish coverage of an entire function or execution.

## Trace an outgoing module edge when it answers the question

For a selected import or re-export, use `trace_web_module_imports`. Supply
explicit inline or document-base context and a local import map only when known:

```json
{
  "manifest_path": "/analysis/exported-scripts/manifest.json",
  "script_index": 0,
  "importer_url": "https://example.test/app/main.js?build=2#entry",
  "import_map": {
    "path": "/analysis/import-map.json",
    "base_url": "https://example.test/maps/"
  }
}
```

Omit optional context when unavailable; the trace then uses the reported source
URL as the importer (`importer.basis: "reported-source-url"`), which cannot
establish an inline script's document base. Literal imports require a
caller-supplied Chromium through an absolute `REA_BROWSER_EXECUTABLE`; a source
with no literal imports does not start a browser. Only REA's resolver stub runs;
captured application code is parsed as data. The selected import map is context,
not proof that the page installed it.

Retain each resolved URL or rejection message and all `captured_candidates`.
Query and fragment variants are distinct; a `response-url-without-fragment`
candidate is weaker than an `exact-reported-url` candidate. Candidate metadata
is recorded capture evidence; only the selected script's bytes are verified
again. Computed imports remain unknown, and a resolved URL with no captured
candidate does not prove the dependency was absent. Do not fetch missing modules
or replace native edges with guessed bundler IDs.

## Finish with a bounded conclusion

Report the selected script and digest, requested and matched coordinates, source
and map Evidence links, candidate module edges and unresolved alternatives.
Separate captured text, map derivation and any inference that connects them to
the feature. Existing execution observations cover their recorded window, not
prior activity; missing coverage is unknown, and a listener or initiator
association alone does not prove feature causality.

Stop when the selected source question is answered. Otherwise name one useful
next probe: retain missing source bytes, obtain an explicitly selected local map,
verify an ambiguous candidate's bytes, or collect a separately scoped execution
window. State what that probe would distinguish; do not expand into navigation,
clicking, page evaluation, remote fetching or unrelated module traversal.
