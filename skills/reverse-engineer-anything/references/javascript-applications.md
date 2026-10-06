# JavaScript and Electron application artifacts

Use `analyze_javascript_application` directly on the operator-supplied ASAR or
extracted tree. The complete result, graph, and Evidence context are returned
inline. Source-map contents are part of the static analysis. Start from its
findings, coverage, unknowns, and graph context, then make a focused follow-up
only when a specific question remains unanswered.

BrowserWindow preferences, preload and contextBridge surfaces, IPC
registrations, utility processes, and native binding requests are static syntax
observations. Only a unique exact literal IPC channel match supports an inferred
pairing. Dynamic or ambiguous channels remain unresolved. A requested `.node`
member is not a verified native export. Never claim runtime reachability,
registration, defaults, or policy enforcement from static analysis.

Use `trace_application_feature` on existing application Evidence for one
literal node ID, route, string, API, IPC channel, module, or native export.
Choose a direction and include the complete application Evidence inline. Include
Hopper or Ghidra Evidence only when its artifact digest matches exactly.

For version comparison, analyze each version once, then call
`compare_application_versions`. Accept only its digest, source-map, structural
fingerprint, or non-module semantic matches. Module ordinals and minified names
are not persistent identity. Report added or removed only with complete
opposite-side coverage; otherwise report unknown.

When the question asks how one exact exported callable's returned object shape
changed, analyze each version once and then call
`compare_javascript_export_shapes` with explicit module paths and export names.
Include the complete Evidence records from both analysis calls. Accept variant
pairing only through the tool's unique exact literal discriminant. Cite the
comparison Evidence and report JSON Pointer changes; dynamic values, ambiguous
variants, and incomplete parent-property coverage stay unknown. This is static
inference, not runtime behavior. When runtime semantics are needed, run
behavioral probes against the relevant application versions and capture them
through the available browser, Electron, or process workflows.

## Reusing application Evidence

Application trace and compare tools accept complete inline Evidence or
`{"kind":"retained-evidence","evidence_id":"ev_<64 lowercase hex characters>"}`
for their application input (`application`, or `left`/`right`). Use the exact ID
returned by the producer on the same MCP connection. Resolution does not run
analysis or select a provider; findings remain inline. Native observation
arrays still take full Evidence. `close_binary` clears retained references;
export a bundle before closing, or supply portable inline Evidence in another
connection. A missing reference includes its ID and recovery guidance.
