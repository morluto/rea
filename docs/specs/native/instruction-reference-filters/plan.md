# Implementation plan

Extend the shared instruction-reference view request schema. The view
projector compares retained row fields and counts matching rows in one scan,
collecting only the requested bounded page. Unfiltered requests still start at
the requested array index.

Advertise the selectors through the existing analysis-view contract. Verify
both MCP schema profiles with retained records and the CLI with a saved
Evidence file. No provider or source acquisition changes are required.
