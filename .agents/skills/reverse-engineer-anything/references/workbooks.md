# Reconstruct a workbook as a desktop app

Hash the original, inspect a copy, and keep the original and any private data
outside example fixtures. For an OOXML package, start with one
`inspect_artifact` inventory. Save the Evidence ID and use its entry paths to
select the workbook, sheet, drawing, chart and pivot parts needed for the
question. An archive listing identifies parts. Interpreting their contents
requires a format-aware parser or the authoring application. Record that
tool's observations separately.

## Trace one write

Start at a named control on a visible sheet. Follow workbook and worksheet
relationships to its drawing or legacy VML control. Record its caption,
anchor, action binding and target procedure. For a VBA project, inspect
available source statically on the copy. Trace procedure calls, referenced
cells or names, list validation, conversions, sign assignment, destination
range or table, refresh, confirmation, clearing and focus. Account for
sheet/workbook events. Unresolved bindings or protected procedures remain
unknown.

Record the action as an input/output example. Capture row count and totals
before and after. Distinguish amount typed, value written and value displayed
(number formats can hide a sign). Check decimal precision, rounding point,
date system, local date order, required fields and how empty values differ
from zero. Include edit/delete effects and duplicate submits. A proposed
behavior change, such as preserving input after a failed write, belongs beside
the observed rule with its reason.

## Trace a result back to records

Start from a visible total, chart series or printed range. Follow formulas,
defined names, structured references or pivot fields through their source
ranges. For a pivot, record filters, grouping, measure, aggregation, cache
source and refresh trigger. For a chart, check its series and categories
against those ranges or pivot results. Identify helper rows, opening balances
and sample transactions from the selection logic and their provenance. A
cached value can describe the last saved state even if the source has since
changed. Record workbook links and dependencies unavailable offline.

## Reconcile the same actions

Use a disposable copy with synthetic rows and an empty app profile. Record
starting income, expense and balance separately. Run each action in both
products. Compare signed rows, period membership, grouped totals, chart data,
printed output and values after closing and reopening. Capture corresponding
screens with the same fixture, locale, viewport, zoom and filter. Compare
labels, control grouping, order, relative positions, keyboard path and focus.
Record source and app evidence for each action, its result and differences.
Mark runs requiring an unavailable spreadsheet host or platform as untested.

### Synthetic worked example

Suppose the form's Post control is bound to AppendEntry. Its positive amount
input is negated once for an expense, appended to the ledger, then included
by a monthly signed sum and its chart. Use this small, hand-checkable ledger
as the expected result for those actions (dates are calendar dates and values
below are integer minor units):

| Action                | Date       | Signed row | Running balance |
| --------------------- | ---------- | ---------: | --------------: |
| Post income 14.20     | 2032-12-31 |       1420 |            1420 |
| Post expense 3.07     | 2033-01-01 |       -307 |            1113 |
| Edit expense to 3.17  | 2033-01-01 |       -317 |            1103 |
| Delete that expense   | 2033-01-01 |    removed |            1420 |

After the edit, the January sum and corresponding chart point must both be
-317. December remains 1420. Reopen offline and compare the two saved rows
before the delete. Also test a blank amount and an intentional pair of
identical legitimate entries. Compare importing the same history twice with
entering those two rows manually. Equal values alone do not establish that
two records are duplicates.
