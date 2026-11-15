# Tasks

- [x] Define the feature scope and plan (`spec.md`, `plan.md`).
- [x] Make the field `Constant` reader the single owner for `Field` and `Param` parents.
- [x] Attribute `ParamList` runs, including `ParamPtr` positions, and report unattributable runs as unknown.
- [x] Report every method's defaults as unknown when an unowned `Param` row declares a default (unlisted by `ParamPtr` or before every run).
- [x] Isolate per-row read failures so sibling defaults survive.
- [x] Add `parameter_defaults` to the member schema, the retained view and the comparison limitation; require the field.
- [x] Read `Param` rows and list coordinates through `BinaryReader`.
- [x] Add synthetic fixture, unit and MCP boundary tests; update the managed code analysis guide.
