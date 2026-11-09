# Typed analysis-run comparison foundation

The domain `compareAnalysisRuns` API compares caller-supplied, schema-validated
run envelopes. It is a foundation for a future focused report, not a generic
Evidence decoder or a public CLI/MCP operation. For supported native function
Evidence, use the existing `compare_functions` workflow. Issue #6338 remains open
for the public run-comparison workflow and producer-owned adapters.

## Interpretation and coverage

The caller supplies operation, predicate, subject and provider context explicitly.
The comparator does not infer these from operation substrings, Evidence digest
order or arbitrary result fields. Malformed or incompatible envelopes return a
tagged incompatibility result.

Each item kind has its own `inventory_coverage`: `procedure`, `finding`,
`obligation`, and `residual_unknown`. An unmatched item is added or removed only
when the other run establishes complete coverage for that inventory. Missing or
null coverage remains unknown. Call-relationship coverage cannot establish
findings inventory completeness. Missing omitted counts and truncation facts
remain unknown rather than becoming observed zero or false.

Procedure records must report their caller and callee arrays; omission is refused
rather than interpreted as an observed empty list. Matched procedures require
complete call-relationship coverage; this foundation refuses incomplete call-list
comparison rather than claiming a semantic change from an unexamined relationship.
Address-based procedure
matching requires the same artifact, known architecture, and matching validated
provider-owned native coordinate commitments in the existing analysis-profile
contract. A repeated address in another binary does not establish identity.
Cross-artifact procedure alignment requires a separate mapping workflow.

## Source references

An item may carry `source_record_ref` with its original Evidence ID and JSON
pointer. Normalization and reordering preserve this pair. Missing references
remain null in the report; projected envelope indices are never advertised as
locations in the original Evidence. Evidence links remain available separately.

The comparator does not mutate its inputs. It normalizes set ordering and declared
presentation fields, retains positive semantic changes and explicit unknowns,
and returns deterministic reports with coverage and validation limitations.
