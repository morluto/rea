# Apple Application Inventory Projection

REA can project one or more authenticated `inventory_artifact` Evidence records
for the same IPA into an Apple application inventory. The projection is
execution-free: it reports exact paths, content hashes, detected formats,
runtime-family hints, and path-based bridge hypotheses. It does not parse plist
or CMS semantics or claim observed runtime calls.

```sh
rea project-apple-application-graph '{"inventory_evidence":[<inventory_artifact Evidence>]}'
```

```json
{
  "name": "project_apple_application_graph",
  "arguments": {
    "inventory_evidence": ["<inventory_artifact Evidence>"]
  }
}
```

The result includes every component in each inventory category and every
JavaScript-to-native bridge candidate pair. It has no caller-selected component
budget, prefix truncation, or omitted-count fields. Duplicate inventory pages
are merged by artifact identity and occurrence path; their Evidence IDs remain
attached as source Evidence.

Coverage is `complete-within-inventory` when the supplied pages reconstruct the
complete authenticated inventory, and `partial` otherwise. A partial result
states that absence is unknown. Component and bridge-candidate arrays are still
the complete projection of the inventory that was supplied.
