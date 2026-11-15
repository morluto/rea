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

3. **Caches keep the whole-state clear.** Recording an effect still calls
   `clearSemanticValueCaches`, which drops every cached value. Per-target
   invalidation was measured and declined; see
   [Per-target cache invalidation](#per-target-cache-invalidation). A
   value-engine read that consults a cache therefore sees every earlier
   effect without asking for it.

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

## Rejected alternatives

### Folding global-code effects into `isUnmodifiedGlobalReference`

One prototype added the global-code check (`eval`, `Function`) to
`isUnmodifiedGlobalReference`, so that every caller of that helper would
refuse a global that opaque code may replace. It was measured at `3d9d35ab26`
on the 14 corpus bundles:

- Static findings and value statuses did not change. No status changed from
  `unknown` to a definite value, and the `unknown` count stayed at 69,348.
- The full semantic IR changed on the 4 bundles that contain `Function(`.
  Callers of the helper dropped operation records without recording an
  `unknown` in their place:
  - handlebars: boundary operations fell from 9 to 3.
  - isomorphic-git: boundary operations fell from 37 to 10 and timer
    operations from 6 to 0. Of the promise operations, 26 were removed and
    17 became unresolved awaited expressions.
  - underscore: timer operations fell from 7 to 0 and boundary operations
    from 3 to 0.
  - vue: boundary operations fell from 36 to 2, timer operations from 9 to 0
    and promise operations from 29 to 23.

The only `Function(` site in handlebars is `Function("return this")()`, which
cannot replace a global, so none of the handlebars removals is justified.
The fold is rejected: it silently drops records instead of marking them
unknown. A read that opaque code may change must stay in the IR and be
reported as unknown, not omitted. Global-code reads go through the effect log
query (decision 2) instead.

### Exempting constant-source `Function` bodies

Exempting constant `Function` bodies that cannot write, such as
`return this`, would have removed the handlebars regressions. The rule is
not adopted: it adds a new precision proof for one observed pattern and is
not needed once readers ask the effect log. It can be proposed separately
with its own measurement.

### Per-target cache invalidation

The first draft of decision 3 invalidated only the cached values that
depend on an effect's target. Existing caches store a result under the
binding it was computed for (`bindingId`), even when it read other bindings,
and the expression and capture caches have the same shape. Per-target
invalidation would therefore need every cached value to record the targets
it read, plus a reverse index from target to dependents.

It was measured at the head of #11282 (effect log slice 1) on the 14 corpus bundles, with
`clearSemanticValueCaches` instrumented locally:

- Clears per bundle range from 1,340 (underscore) to 32,269 (openpgp).
  Almost all come from the member-mutation phase, which clears once per
  recorded effect.
- The binding values those clears discard are few: 0 to 306 primitive and
  36 to 1,391 caller-independent values per bundle. The expression and
  capture caches are `WeakMap`s, so their entries were not counted.
- Upper bound: with every clear disabled (unsound; the IR changes on all 5
  measured bundles), CPU time fell by 9% on zip.js and isomorphic-git, 8% on
  openpgp and 4% on rxjs, and did not change measurably on vue. Peak RSS did
  not change. These are 2 alternating runs per bundle under a load average
  of 9 to 11, so the smaller figures are within noise.

Per-target invalidation could recover only part of that 4 to 9% bound, at
the cost of dependency tracking in every value cache and a reverse index.
It is declined.

Clearing once per member-mutation convergence round instead of once per
effect is also declined. Values read later in the same round would be stale,
and there is no argument yet that the round's fixed point makes them safe.

## Consequences

- A new reader cannot forget an effect kind, because it asks one question
  about the value it reads.
- Effect proofs have one owner. A precision fix, such as a new disjointness
  proof, applies to every reader at once.
- Cache invalidation is unchanged: every recorded effect still clears the
  whole value state. Removing every clear would save at most 9% CPU on the
  measured bundles.
- The log retains effect entries until the source's analysis ends. They are
  already retained today in `bindingWrites`, `memberWrites`, `escapedPaths`,
  the ambient effect lists and `opaqueEffects`. The log replaces those
  indexes rather than adding a copy.
- Until the last slice lands, readers use both forms. The guard's counted
  baseline can only shrink.
