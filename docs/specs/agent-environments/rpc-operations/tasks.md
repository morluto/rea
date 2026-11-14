# Tasks

- [x] Select bounded operation names for GraphQL, JSON-RPC and `batchexecute`.
- [x] Parse guarded and length-framed JSON responses within their limits.
- [x] Split overlapping POST groups by operation in the manifest; keep single-operation names plain.
- [x] Separate read and write operations in state; keep declared mutations and subscriptions writes.
- [x] Dispatch replay and comparison to the recorded operation; refuse unrecorded operations on split paths.
- [x] Keep pre-RPC saved bundles deriving the same state.
- [x] Document the behavior and add unit, domain and application tests.
