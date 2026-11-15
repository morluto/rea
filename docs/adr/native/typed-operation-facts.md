# Native operation results are parsed once at the operation port

## Status

Proposed. Needs a maintainer decision before implementation.

## Context

`AnalysisOperationPort.execute` returns `AnalysisExecution` whose `result` is
an untyped `JsonValue`. Four provider-neutral readers parse that value again,
each with its own schema and failure policy:

| Reader                             | Operation                             | Schema applied                                                | On mismatch                                 |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------------------- | ------------------------------------------- |
| `EnhancedLiteralTracing`           | `search_strings`, `search_procedures` | `nativeInventoryRowsSchemas.*`                                | `AnalysisOutputError`                       |
| `NativeDispatchMetadataInspection` | `list_names`                          | `names.element.strict()`                                      | `AnalysisOutputError` with partial Evidence |
| `functionInventory`                | retained `list_procedures` Evidence   | `names.element.extend({ address: nativeAddressInputSchema })` | throws the payload error                    |
| `nativeInventoryView`              | retained `list_*` Evidence            | `nativeInventoryRowsSchemas.*`                                | view error                                  |

Ghidra and Hopper already validate these replies at their clients against the
same domain schemas; other providers do not. A consumer therefore cannot know
whether a `JsonValue` it receives was checked, so each one checks again with a
slightly different contract. A "validated" marker on the execution was
considered and rejected: it adds a second representation of the same fact and
consumers would still need the typed value.

## Decision

1. **One provider-neutral table.** `src/domain/native/nativeOperationResults.ts`
   maps each native operation to its source result schema (`list_names`,
   `list_procedures`, `search_procedures` to `nativeInventoryRowsSchemas.names`;
   `list_strings`, `search_strings` to `.strings`; `xrefs`,
   `procedure_callees`, `procedure_callers`, `procedure_address`,
   `resolve_containing_procedure` to `nativeObservationSourceSchemas`;
   `list_segments`, `procedure_info`, `read_bytes`, and so on). The advertised
   output schemas (`officialOutputSchemas`) and Hopper's reply table derive
   their entries from it, so there is one definition per operation.
2. **The port owns the parse.** `BinarySession` (the port implementation)
   parses a result whose operation is in the table once, when the provider
   returns it, before any consumer or Evidence projection sees it. A mismatch
   is an `AnalysisOutputError` that keeps the source Evidence as partial
   observation. The policy is the same for every provider.
3. **The port exposes the parsed fact type.** The port gains a typed read,
   `executeFact<O extends NativeFactOperation>(operation: O, parameters,
   options)`, returning `AnalysisExecution & { readonly fact:
   NativeOperationResult<O> }`. `execute` is unchanged for other operations.
   Wrapping ports (`WorkflowEvidence`, admission) forward it.
4. **Consumers read typed facts.** The four readers above drop their schemas
   and consume `fact`. Reader-specific requirements stay with the reader as
   a step over typed rows, not as a different parse of the raw value:
   `functionInventory` parses each row's address with
   `nativeAddressInputSchema`; `NativeDispatchMetadataInspection`'s
   `.strict()` row check either becomes part of the table's row schema or is
   dropped, which needs a decision (below).
5. **Retained Evidence.** `nativeInventoryView` and `functionInventory` read
   Evidence produced by the port, so they read through the same table entry keyed by the parent
   operation; replay of Evidence produced before this change still parses.

## Consequences

- One contract and one failure policy per operation; a provider that returns
  malformed rows fails at the port with the same error for every consumer.
- Hopper's and Ghidra's client checks for neutral operations become
  duplicates of the port parse. Keep them as provider protocol checks, or drop
  them in a follow-up once the port parse lands (decision needed).
- Open questions for the maintainer:
  - Should the table's name rows be strict (reject unknown fields), as
    `NativeDispatchMetadataInspection` does today, or loose, as the other
    readers are? Strict rejects provider extensions the other readers accept.
  - Is `executeFact` on the port acceptable, or should `AnalysisExecution`
    become generic in its operation?
- Implementation order: table and port parse (no consumer change), then one
  PR per reader, deleting its local schema. `EnhancedLiteralTracing` is the
  smallest first reader.
- Evidence format is unchanged: the parsed value is the source value, because
  the table's schemas carry no transforms.
