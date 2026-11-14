# Pages of matching procedure aliases

[Design discussion](https://github.com/morluto/rea/issues/8814)

A bounded procedure page can still return every matching alias of one row.
Allow a caller to select the row by its original source index and read its
matched aliases in a separate bounded page. Preserve recorded order, alias
indices, the primary name and the parent identity. Missing alias observations
remain unrecorded. Retained matches cannot establish full alias discovery.

## Acceptance

Follow a continuation over recorded aliases. Exercise same-address rows, missing
alias observations, a larger caller-selected page, and byte-budget refusal.

## Non-goals

- Querying a provider during alias paging.
- Discovering names beyond the retained search match.
- Changing primary-name matching or the existing procedure-row view.
