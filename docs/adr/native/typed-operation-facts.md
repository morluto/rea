# Native operation results are parsed once at the operation port

## Status

Accepted (2026-11-15). The maintainer decisions are recorded under
[Decision](#decision); implementation lands one reader per PR.

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

1. **Named operation contracts.** `src/domain/native/nativeOperationFacts.ts`
   exports one named contract per native inventory operation (`list_names`,
   `list_procedures`, `search_procedures`, `list_strings`, `search_strings`).
   Each contract carries its operation name and its row schema from
   `nativeInventoryRowsSchemas`, with the exact fact type. Readers import the
   contract they need; nothing looks a contract up by operation name or by
   catalog order. Other operations gain a contract only when a reader needs
   one.
2. **Name rows are lenient.** A row with fields the contract does not name is
   accepted and the unknown fields are dropped from the typed fact, for
   forward compatibility with provider extensions. This matches three of the
   four readers today. `NativeDispatchMetadataInspection`'s `.strict()` row
   check is removed.
3. **The port parses once: `executeFact`.** The application port module
   exports `executeFact(port, contract, parameters, options)`. It runs the
   operation through the given port's `execute` and parses the result with the
   contract once, returning
   `{ execution: AnalysisExecution; fact: Fact }`. A mismatch is an
   `AnalysisOutputError` naming the operation, keeping the source execution as
   partial observed Evidence. The policy is the same for every provider and
   every reader. Because it runs through the port's own `execute`, a wrapping
   port (`WorkflowEvidence`, admission, managed-tool wrappers) observes and
   records the call exactly as it does today, with no forwarding code.
4. **Evidence keeps the source value.** The typed fact is a projection for
   consumers. `AnalysisExecution.result` and the Evidence built from it keep
   the provider's value unchanged, including the unknown fields that the
   lenient contract drops from the fact. Nothing writes the parsed fact back
   into Evidence.
5. **Readers consume facts.** The four readers drop their local schemas.
   Live readers call `executeFact`. Retained-Evidence readers
   (`nativeInventoryView`, `functionInventory`) read the payload of Evidence
   the port produced through the same contract's schema, keyed by the parent
   operation's contract. Reader-specific requirements stay with the reader as
   a step over typed rows, not as a different parse of the raw value:
   `functionInventory` parses each row's address with
   `nativeAddressInputSchema`. Evidence produced before this change still
   parses, because the contracts are the schemas those readers used.
6. **Provider protocol checks stay.** Hopper's reply table
   (`HopperReplyContracts`) and Ghidra's per-operation result schemas remain:
   each owns its raw provider protocol and rejects a malformed reply at the
   client with provider-specific recovery. The port parse is the
   provider-neutral fact parse and is not a duplicate of either; no reader
   re-parses after it.

## Alternatives considered

- **A required `executeFact` method on every `AnalysisOperationPort`.**
  Measured on 4b31661441: making the method required on the port (with
  provider clients moved to an execute-only base) produced 626 type errors in
  242 files, almost all test fakes and object-literal ports that would each
  forward the same derived function. A wrapping port that forwarded the
  method to its inner port would also bypass its own observation, so each
  wrapper would have to re-derive it from its own `execute` anyway. The
  port-module function gives every port the same typed read with one
  implementation.
- **Make `AnalysisExecution` generic in its operation.** Rejected: every
  provider and Evidence projection would carry a type parameter for a fact
  only four readers consume.

## Consequences

- One contract and one failure policy per operation; a provider that returns
  malformed rows fails at the port with the same error for every consumer.
- Unknown row fields stay visible in Evidence and disappear only from the
  typed fact.
- Implementation order: contracts and `executeFact` with no consumer change,
  then one PR per reader, deleting its local schema: `nativeInventoryView`,
  `functionInventory`, `NativeDispatchMetadataInspection`,
  `EnhancedLiteralTracing`.
