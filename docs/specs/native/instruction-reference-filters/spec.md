# Exact filters for retained instruction references

Related to [selecting recorded references by source address](https://github.com/morluto/rea/issues/8866)
and [paging retained instruction references](https://github.com/morluto/rea/issues/8593).

## Problem and outcome

An analyst who knows an address can still have to download and inspect many
pages to find its typed incoming or outgoing reference. Allow exact lookup
within the existing native-instruction-references view over saved Evidence.

## Requirements

- Accept optional `source_address` and `target_address` selectors on either
  reference collection. Compare the retained address strings exactly and
  intersect the selectors when both are present.
- Preserve retained order, duplicates and original row indices. Apply offset
  and limit to matching rows. Coverage reports the matching total.
- An omitted or null source address does not match an explicit selector.
  An empty match set remains distinct from unavailable or unrecorded source
  collections. A match describes a recorded reference observation.
- Preserve the existing page byte budget and unfiltered paging behavior.

## Acceptance

Exercise source and target selectors, both selectors together, duplicate rows,
empty selections and missing observations through the CLI and MCP. Verify
that a filtered page can omit a nonmatching oversized row and that a matching
oversized row still triggers the existing recovery path.
