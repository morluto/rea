# Evidence names its subject with one tagged target identity

## Status

Accepted (2026-11-15). Implementation lands in slices: the first slice does not
change Evidence IDs, and the slice that does is breaking (marked `!`, with
recreate-observations migration notes) and ships with the next Evidence format
revision.

## Context

"The target" is defined three ways, with different fields:

| Definition                   | Fields                                                                                           | Owner                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Evidence subject identity    | `digest.sha256`, `format`, `architecture`                                                        | `evidenceSubjectIdentity` in `src/domain/evidence.ts` |
| Snapshot target              | `sha256`, `kind`, `architecture`, `format`, plus `entry_point` (raw, DOL) or flash offsets (ESP) | `snapshotTarget` in `src/domain/analysisSnapshot.ts`  |
| Snapshot cache stage compare | `JSON.stringify` of the snapshot target (key-order sensitive)                                    | `AnalysisSnapshotCache.stage`                         |

The Evidence subject schema can only describe a hashed local file. Of 120
non-test `createEvidence` calls, 50 pass no subject and receive the generic
limitation "Artifact identity is unavailable for this observation." (measured
on main at c56fffcd75): application 29, contracts 7, gdb 6, server 3, domain 3,
rizin 1, cutter 1. Every gdb, rizin, live-browser and process-capture record is
subject-less, because a URL, a running process or a debugger session cannot be a
subject. Comparison and workflow records are subject-less because they derive
from several linked records.

Consequences today:

- Two raw-binary observations of the same bytes at different entry points share
  an Evidence subject identity unless the operation echoes the entry point into
  `parameters`. The snapshot target keeps them apart.
- Debugger, browser and process Evidence cannot be bound to what it observed.
  A rebuilt binary under the same path, or a different page at the same tool
  input, is indistinguishable in the record.
- Consumers that compare targets each reimplement the comparison.

The Evidence format revision (`src/domain/evidenceFormat.ts`, #10861) gives
Evidence one place to evolve. Phase 5 deferred two items to this decision: the
target identity, and a per-record format marker. A standalone record (outside a
bundle) does not declare its format today.

## Decision

1. **One tagged identity.** `src/domain/targetIdentity.ts` owns
   `TargetIdentity`, discriminated by `kind`:
   - `file`: `sha256`, `format`, `architecture` (nullable) and `selection`.
     `selection` holds the facts that select what was analysed in the bytes:
     the raw or DOL entry point, ESP flash and partition-table offsets, and a
     universal-binary slice. It is `null` when nothing is selected.
   - `url`: the URL with userinfo removed and its `origin`. Userinfo is a
     transport credential and is never part of an identity.
   - `process`: `pid`, `start_time` (nullable when the platform does not report
     it), and `executable_sha256` (nullable when the executable could not be
     read stably). A PID alone does not identify a process after exit or reuse
     (see the `src/process/` identity primitives). A record whose start time is
     unknown says so, rather than claiming an identity it does not have.
   - `session`: the session `kind` (for example `gdb`, `rizin`,
     `browser-scenario`), the session `id` REA minted, and the `target` the
     session was opened on (a `TargetIdentity`, possibly `unknown`).
   - `unknown`: a `reason` from a closed set:
     `derived-from-linked-evidence` (comparisons and workflows; their sources
     are already committed through `evidence_links`), `not-observed`, and
     `unsupported-subject`.

   Display facts (`name`, `local_path`) stay beside the identity and are not
   committed, as today.

2. **One key.** `targetIdentityKey(identity)` is the RFC 8785 canonical digest
   of the identity. Evidence, analysis snapshots, caches and session binding
   compare targets only through it. `evidenceSubjectIdentity`,
   `sameEvidenceSubjectTargetIdentity`, `snapshotTarget`'s field-by-field
   `snapshotMatchesTarget` and the `JSON.stringify` compare are deleted.
3. **Every record has a subject.** `createEvidence` takes a `TargetIdentity`,
   not `undefined`. A producer that cannot name its subject passes
   `unknown` with a reason, so "no identity" is an explicit, reasoned value.
   `MISSING_EVIDENCE_SUBJECT_LIMITATION` is removed; the reason replaces it.
4. **Evidence format revision 2.** The new subject changes the committed
   content of every Evidence ID, including file subjects (which gain `kind` and
   `selection`). It therefore ships as one breaking revision:
   - `EVIDENCE_FORMAT_REVISION` becomes 2 and its revision note names the
     subject change.
   - Every Evidence record carries `evidence_format: 2`, so a standalone record
     declares its format too. The marker is not part of the ID's committed
     content; it selects the reader, and `admitEvidenceBundleFormat` gains a
     per-record check with the same refusal.
   - Analysis snapshots embed Evidence and target identities, so snapshot
     files from revision 1 are refused at open.
5. **No migration of stored Evidence.** An Evidence ID is a content
   commitment. Rewriting a revision 1 record under a new subject would claim an
   observation REA did not make. Revision 1 bundles, records and snapshots are
   refused with `RECREATE_EVIDENCE_GUIDANCE` (recreate the observations with the
   current release). The bundle reader already does this for pre-revision
   bundles.

### Slices

1. Introduce `TargetIdentity` and `targetIdentityKey`. Use them for snapshot
   and cache comparison (replacing the `JSON.stringify` compare), and let
   `BinaryTargetResolver` produce the file identity through the shared stable
   file hasher. No Evidence ID changes; not breaking.
2. Evidence format revision 2 (breaking, `!`): the subject becomes
   `TargetIdentity` plus display facts; the per-record marker is added; the 50
   subject-less sites pass an explicit identity: `unknown`
   (`derived-from-linked-evidence`) for comparisons and workflows, and the
   best identity each producer already holds for the rest.
3. Producers gain real identities where they have the facts: gdb and rizin
   `session` identities bound to the opened file, live browser `url`, process
   capture `process`. Each is its own PR and changes only that producer's IDs,
   which is still within revision 2 if it lands before the release; otherwise
   it needs its own revision.

## Consequences

- Every Evidence ID changes once, in the release that ships revision 2.
  Callers that stored Evidence IDs or bundles must recreate them; the release
  notes carry the `BREAKING CHANGE` footer and this migration.
- Debugger, browser and process Evidence can be bound to what it observed, and
  two observations that differ only in their selection (entry point, slice,
  flash offset) no longer share a subject.
- Target comparison has one owner. Session registries can store the identity at
  open and revalidate it before each call (a follow-up, not part of this
  decision).
- `unknown` keeps "the identity was not observed" visible as a fact with a
  reason, instead of an absent field with a generic limitation.
- Revision 2 also takes the remaining fields that are optional only because
  older Evidence may omit them. Those that every producer writes become
  required in the same revision.
