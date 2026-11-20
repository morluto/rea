# Managed parameter constant defaults

## Problem and outcome

`inspect_managed_members` decoded ECMA-335 `Constant` rows only for fields. A
`Param` row with `HasDefault` (an optional parameter's default value) had no
value anywhere in the result, and the inspection limitation said parameter
defaults were not decoded. Report, for each selected method, the parameter
defaults its metadata declares, with the same constant record that fields use.

## Requirements

- One `Constant`-table owner indexes `Field` and `Param` parents once per
  inspection and decodes a declaration only for a selected member, with the
  existing element types, value encodings, `raw_hex` and `unavailable` states.
- A method owns the `Param` rows of its `ParamList` run (ECMA-335 II.22.26):
  from its start up to the next method's start, through `ParamPtr` positions
  when that table is present.
- `parameter_defaults` lists, in run order, each owned row that declares
  `HasDefault` or owns a `Constant` row: token, row offset, sequence, name,
  flags and the constant record. Rows without either are examined and omitted.
- An empty list means the run was examined. `null` means the defaults are
  unknown, with an `invalid-row` issue and partial coverage, when:
  - the method's run cannot be attributed (out-of-range coordinate, a run that
    ends before it starts, a run out of order with another nonempty run, or an
    invalid `ParamPtr` table); or
  - a `Param` row with no owning method declares a default, because no
    `ParamPtr` row lists it or its list position precedes every method's run.
- One unreadable `Param` row is reported as a parse issue without hiding the
  defaults of its siblings.
- The field is required and nullable; member records without it are refused.
- Rows without a default are neither retained nor charged against the
  metadata representation budget.
- Retained `managed-members` views can select `fields: ["parameter_defaults"]`.
  Member comparison discloses that it does not compare parameter defaults.

## Acceptance

Synthetic PE fixtures cover decoded and unavailable defaults, field and
parameter defaults from one `Constant` table, empty runs, unattributable and
out-of-order runs, `ParamPtr` attribution, invalid `ParamPtr` tables, unowned
default rows (unlisted and leading), an unreadable sibling name, unselected
methods, view projection and the comparison limitation. MCP boundary tests
cover inspection and the retained view. No compiled assembly is inspected.

## Out of scope

Property defaults, comparing defaults across artifacts, enum-name mapping of
values, and runtime parameter values.
