# Retained Evidence referrers

## Status

Implemented and acceptance checks passed on 2026-11-16. See the
[verification record](plan.md#verification) for completed checks and the existing
repository-wide `knip` limitation.

## Problem

An analyst can inspect a retained result's source Evidence links, but cannot
select the retained results that directly cite one Evidence ID without reading
every link row. The cited record may be absent from the current investigation.

## Requirements

1. Extend `get_evidence_bundle` and `inspect-evidence-bundle` link inspection with
   an optional exact `linked_evidence_id`. Return only direct links to that ID;
   preserve each source ID, target ID and actual retained/missing membership.
2. Keep existing source-record filters and outgoing traversal semantics.
   Source filters choose roots, and `retained-closure` may expand the examined
   sources before the target filter is applied. Do not traverse incoming links.
3. Default `link_status` to `all` when a target is supplied, otherwise retain the
   existing `missing` default. Apply status and stable pagination after the
   target filter. Link counts describe target-matching edges before status;
   closure completeness still describes every outgoing edge examined.
4. Restrict the target selector to `detail: "links"` and validate its Evidence
   ID syntax. A missing target and zero referrers describe only the current
   session or file; neither establishes global absence or analysis completeness.
5. Read the current immutable bundle without provider work, new retained state,
   or a cache. Import and reset must immediately change subsequent inspection.

## Acceptance

Public MCP and CLI queries agree on direct referrers, missing targets, source
selection and paging. MCP contracts validate with output advertisements off and
compact, and against the complete canonical output schema. Repeated import
creates no duplicate rows, importing a target changes membership, and reset
leaves no stale referrers. Existing outgoing inspections
retain their results, including incomplete closure hidden by a target filter.

## Non-goals

No graph database, graph language, new tool, incoming transitive traversal,
automatic persistence, Unknown relationship graph, provider execution, or
inference that a citation proves a conclusion.
