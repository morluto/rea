# JavaScript effects invalidate reads through one effect log

## Status

Accepted (2026-11-15) for plan W10 step 3. Implementation lands in slices, one
target kind per PR. Each slice removes the reader-side checks it replaces and
reports its corpus measurement.

## Context

The semantic engine records effects while it indexes a source:

- binding writes;
- member writes and escapes from the member-mutation phase;
- ambient writes and escapes;
- direct `eval` sites that may rebind names in visible activations;
- global-code sites (`eval`, `Function`) that may replace globals.

Readers then pull invalidation by calling one helper per effect kind before
they trust a value. Measured at `104b1a35b4`, outside the owner module
`javascriptSemanticOpaqueEffects.ts`, 32 calls in 14 files make this check:

| Helper                                    | Calls | Files |
| ----------------------------------------- | ----: | ----: |
| `referenceMayHaveChangedAt`               |    12 |     8 |
| `semanticOpaqueBindingReadMayHaveChanged` |     7 |     5 |
| `semanticOpaqueGlobalMayHaveChanged`      |     4 |     4 |
| `semanticBindingMayHaveOpaqueEffect`      |     4 |     2 |
| `semanticOpaqueNameMayHaveChanged`        |     3 |     2 |
| `semanticOpaqueBindingEffects`            |     2 |     1 |

Most readers combine two to four of these calls. For example, an intrinsic
read combines `semanticOpaqueNameMayHaveChanged`,
`semanticOpaqueGlobalMayHaveChanged` and `ambientEscapes.covers`, and a
receiver walk calls `referenceMayHaveChangedAt` for both the method and
`__proto__`.

A reader that omits one of these calls reports a stale fact with complete
coverage. The direct-eval invalidation fix had to land twice, six days apart:
`9ac76d3d94` for semantic values and `26e155987f` (#7053) for Electron reads.
The structural audit (report 14, C1 point 5) records this as "readers must
ask".

The classification of implicit execution (#10605, #10631) and the
member-mutation work allowance (#11144) do not replace these checks. They
decide where code may run and bound the work, but readers still decide
separately whether a recorded effect applies to their read.

## Decision

1. **One effect log owner.** `javascriptSemanticEffectLog.ts` holds every
   recorded effect, keyed by its target:
   - a binding id;
   - an ambient root path;
   - an activation scope, for name introduction by sloppy direct `eval`;
   - global code.

   Each entry keeps the effect node, its kind and its property path.
   Producers append to the log when they record an effect. Nothing else
   writes to it.

2. **One read query.** Readers ask whether a read of a target, at a site and
   for a property path, may observe an earlier effect:
   `effectLog.mayObserve(read, target, path)`. They state the value they
   read, not the effect kinds that could change it.

   The owner keeps the existing proofs inside this query: effect timing,
   capture-before-effect, read-before-effect within one activation, strict
   and sloppy `eval`, and path disjointness. No reader evaluates these
   proofs.

3. **Push invalidation to caches.** Recording an effect invalidates every
   cached value that depends on its target. Existing caches store a result
   under the binding it was computed for (`bindingId`), even when it read
   other bindings, and expression and capture caches have the same shape.
   Invalidation must therefore reach dependents, not only the changed
   target's own entry. Each cached value records the targets it read, and
   the log invalidates through that reverse index. Until a slice adds that
   dependency tracking for a cache, the current whole-state
   `clearSemanticValueCaches` stays in place for it. A value-engine read that
   consults a cache then sees the effect without asking for it.
4. **Completeness is explicit.** The log records which producer phases are
   complete. Before the member-mutation phase completes, a member-path query
   answers "may observe", which is the current conservative
   `referenceMayHaveChangedAt` behavior when nothing is indexed. A phase
   refused by its work allowance never completes.
5. **Guard.** After each slice, an architecture guard forbids importing the
   superseded helpers outside the effect log. When the last slice lands, the
   helpers are deleted and the guard prevents a new reader-side check from
   returning.

## Migration

Slices move one target kind at a time, so each stays reviewable and
measurable:

1. Global code and introduced names. This covers
   `semanticOpaqueGlobalMayHaveChanged` and `semanticOpaqueNameMayHaveChanged`
   at intrinsic and global reads (typed arrays, timers, async effects, module
   interop and expression shapes).
2. Binding rebinding. This covers `semanticBindingMayHaveOpaqueEffect`,
   `semanticOpaqueBindingReadMayHaveChanged` and `semanticOpaqueBindingEffects`.
3. Member paths. This covers `referenceMayHaveChangedAt` (receiver walks,
   network, Electron, map, route and resource readers) and the effects view in
   `visitSemanticReferenceEffectsAtSite`.

Each slice is measured cold on the 14 published bundles of the W10 corpus,
before and after. The measurement covers per-value status digests, the total
`unknown` count, elapsed and CPU time, and peak RSS. A slice that changes no
proof should change no status.

The slice stops and is reported, not merged, if it shows either of these:

- `unknown` rises by more than 0.1% of examined values on the corpus, or on
  any single bundle;
- a status changes from `unknown` to a definite value. That is a soundness
  regression and is never accepted.

Merging `JavaScriptSymbolicBindings` (W10 step 4, audit C2) follows the last
slice, because its one consumer should read values through the same log.

## Consequences

- A new reader cannot forget an effect kind, because it asks one question
  about the value it reads.
- Effect proofs have one owner. A precision fix, such as a new disjointness
  proof, applies to every reader at once.
- Once dependency tracking covers a cache, its invalidation follows its
  dependents instead of clearing the whole state after a global site. This
  should reduce recomputation on bundles that contain `eval`. The effect is
  unmeasured until a slice adds that tracking, and caches without it keep the
  whole-state clear.
- The log retains effect entries until the source's analysis ends. They are
  already retained today in `bindingWrites`, `memberWrites`, `escapedPaths`,
  the ambient effect lists and `opaqueEffects`. The log replaces those
  indexes rather than adding a copy.
- Until the last slice lands, readers use both forms. The guard's counted
  baseline can only shrink.
