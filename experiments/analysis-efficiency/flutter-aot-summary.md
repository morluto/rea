# Dart AOT summary and retained string pools

Continues [#2016](https://github.com/morluto/rea/issues/2016) and
[#2455](https://github.com/morluto/rea/pull/2455). The selected analyst question
asks for shipped LocalSend target/ABI/library identity, every nullable snapshot
observation, string-pool lower bounds and returned counts, and original coverage
and limitations. It does not require individual observed strings.

## Compatibility and ownership

MCP `inspect_dart_aot` accepts explicit `detail: "summary"`. Omitted and complete
requests preserve the complete result and original provider inputs. The CLI
remains complete. ABI omission and explicit ABI selection retain their original
meaning; the provider never receives the delivery field. Missing retention,
invalid detail and pre-cancellation fail before provider work.

The existing application workflow retains the complete original Evidence, then
returns a distinct derived summary linked to its parent ID. It preserves target
and libapp digests, every snapshot section and nullable fact, original pool and
overall coverage, lower-bound counts and limitations. `returned_counts` reports
the lengths of the producer-returned arrays; it does not upgrade lower bounds
to a complete snapshot inventory. The analysis and original source retention
are unchanged. No new engine, persistent cache or plugin SDK is introduced.

Read exact retained strings using `inspect_analysis_view`, the parent ID, and
`view: {kind: "dart-aot", collection: "package_uris", offset: 0, limit: 64}`.
Other collections are `dart_uris` and `class_like_tokens`. Follow the returned
next offset. Pages preserve source order, ABI/library identity and partial pool
coverage without opening the APK again. Page exhaustion describes retained
strings, not the entire snapshot. Strings remain byte-pattern observations,
rather than recovered typed class/function semantics. Missing historical
subjects remain explicitly unknown; conflicting recorded target digests fail.

## Frozen runtime and real SDK pairs

The official LocalSend 1.18.2 arm64 APK acquisition, size and SHA-256 are pinned
in `corpus.json`. No APK installation, target execution or version-dataset
lookup occurred. Source runtime: `811034a7283c9751a3ecbff33e8b2f28bec55793`;
compiled dist/bridge file-table SHA-256:
`dabbb63536c5862be839ecdc0f3eaad05b29c2a3816f57041528d30f754311be`.
The previous runtime is `28c84e78cf2fbfde4aceed345b773c59eb889f68`, digest
`5332dda13981f043e146b3601ebec1f380d9f698280ca53d75786b638a912e11`.
Its production sources were verified byte-equal to main f254 at acquisition.
Subsequent test-only changes and main's SAZ addition do not relabel these pins.

Node is 24.18.0 and the SDK client/server are 2.3.1. Each workflow starts a fresh
server and validates the selected live advertised schema. Artifact bytes,
provider environment/search-path fingerprints, driver and locked dependencies
stay equal. Host page caches are not flushed. Heavy tasks run serially under
the unchanged CPU, memory, task and host guards.

| Trial          | AOT reply bytes | SDK workflow seconds | Payload CPU seconds | Kernel peak bytes |
| -------------- | --------------: | -------------------: | ------------------: | ----------------: |
| sdk-complete-1 |         151,341 |                5.139 |               6.819 |       691,441,664 |
| sdk-summary-1  |          12,037 |                5.219 |               6.608 |       639,430,656 |
| sdk-summary-2  |          12,037 |                5.064 |               6.405 |       640,868,352 |
| sdk-complete-2 |         151,341 |                5.128 |               6.468 |       633,614,336 |

Both pairs use one successful public tool call and pass settings/fact comparison,
including all snapshot fields, coverage, original limitations and all counts.
Reply bytes fall 92.05%. Whole SDK time stays approximately 5.1 seconds; these
trials do not establish engine speed, CPU or memory savings. Payload CPU includes
driver/catalog work beyond the SDK workflow timer. Catalog JSON grows from
2,506,213 bytes on the previous runtime to 2,514,896 (about 0.35%).

A fresh old-runtime complete request passes comparison against candidate
complete, including identical 151,341-byte replies. This is scoped compatibility
evidence, not a guarantee for every historical release or third-party client.

## Real old Evidence continuation

Fifteen successful public MCP calls import genuine old-runtime AOT Evidence,
project retained summary, reconstruct all 500 package URIs, 216 Dart URIs and
2,000 class-like tokens, compare inline portable summary, and export the original
record. The APK is absent during all these operations. Original string order,
lower bounds, partial coverage, nullable snapshot facts, subject and parent ID
remain intact; the original exported record is deeply equal to its source.

The first private verification attempt used a nonexistent receipt filename and
failed before import or artifact relocation. That driver error is retained;
the corrected attempt selects the fresh old-runtime record. It is not a REA
defect or a successful migration trial.

## Actual Codex task outcomes

Four serial trials use the same frozen candidate in complete/summary/summary/
complete order. Requested configuration is Codex CLI 0.161.0, `gpt-5.6-terra`
high, one exact enabled tool (`inspect_dart_aot`), and identical optional owned
context capture/discovery guidance. This requested alias does not certify the
server-resolved model. Temporary configuration points to the modified frozen
REA MCP; all copied credential profiles are removed and target bytes remain
unchanged. The source question is fixed; equal treatment instructions choose
detail and explain the summary carrier and parent reference.

| Trial            |  Input | Cached | Uncached | Output | Seconds | MCP attempts | Failed attempts | Facts |
| ---------------- | -----: | -----: | -------: | -----: | ------: | -----------: | --------------: | ----- |
| model-complete-1 | 74,641 | 50,176 |   24,465 |  2,765 | 116.898 |            3 |               1 | pass  |
| model-summary-1  | 38,253 | 22,016 |   16,237 |  1,449 |  88.904 |            1 |               0 | pass  |
| model-summary-2  | 38,363 | 22,016 |   16,347 |  1,515 |  55.190 |            1 |               0 | pass  |
| model-complete-2 | 66,585 | 38,144 |   28,441 |  2,217 |  79.180 |            2 |               0 | pass  |

Both pairs pass checks for every selected producer fact, exact nullable
observations, target digest, observed response Evidence IDs, original limitations,
artifact preservation and profile cleanup. The grader compares the reported
facts with producer observations; it is not an independent Dart deserializer.
Total input falls 48.75% / 42.38%, uncached input 33.63% / 42.52%, reported output
47.59% / 31.66%, and whole-task time 23.95% / 30.30%. Usage is the final aggregate
reported by the actual CLI, one usage record per trial; cached tokens are not
subtracted from total input. Reported output includes reasoning output (1,262,
321, 383 and 709 tokens respectively).

The first complete trial initially supplied `artifact_path` instead of the
advertised `path`, corrected it, then repeated a successful complete call.
The second complete trial made two successful calls. Both summary trials made
one successful call. All attempts, discovery and correction costs remain
included. The paired whole-task improvement therefore includes actual model
decisions and the convenience of explicit returned counts; it does not isolate
serialization as the sole cause or establish engine acceleration. Two pairs on
one app/question/model configuration support this scope, not a universal gain.

Payload CPU seconds / kernel peak bytes are respectively 12.556 / 876,937,216;
9.213 / 785,272,832; 9.108 / 793,939,968; and 13.164 / 803,209,216. Model payload
observations verify owned cleanup and zero phase limit events, with no guard
aborts. Whole-scope final counters remain unknown, so every strict all-selected
resource grade remains false even though the separate factual grade passes.

## Resource and verification scope

SDK and migration payload-exit observations verify owned cleanup and zero
observed memory/pids limit events, with peaks below 692 MB. Missing whole-scope
terminal counters remain unknown; the strict whole-resource grader stays false.
One-CPU quotas are experiment controls rather than CPU-efficiency claims.

Production-provider fixture tests cover explicit ABI, old complete defaults,
actual SDK-converted schemas, exact pages after APK removal, portable records,
nullable/partial facts, malformed inputs, target digest conflicts and early
refusals. CLI/MCP acceptance covers original report equality, duplicate-member
refusals and unsupported snapshot kinds. Fixture successes are distinguished
from the real LocalSend SDK/migration workflows. Other Flutter apps, architectures,
SDK layouts, typed class recovery and runtime behavior remain unverified here.
Raw replies, binaries, model traces and temporary credentials stay outside Git.

## Integration with the newer main

The rebased verification runtime is `63984ce0898bd7997e6d9b138e6d96d0a24f2b09`
on main `a2d8b94dd50dab8d966239dd63ab84718aa8b4b4`, with compiled file-table
SHA-256 `19c8ccdd3e99bb46a5c54f4edd8c6b2d2eb4f3a4870b3c129061d38145382b68`.
Targeted Flutter/SAZ/shared-view integration passes 35 tests; one opposite
runtime-capacity branch is skipped because this host enforces decoder memory.
Documentation checks and two README conformance tests pass.

Fresh real complete/summary SDK checks on this runtime match the earlier selected
facts and settings, with unchanged 151,341 / 12,037-byte AOT replies. Fifteen
old-Evidence migration calls again preserve every original string and record
with the source APK absent. The real one-shot CLI complete result also matches
the previous-runtime normalized report, subject, parameters and original ID.
An initial CLI-only controller check lacked an owned resource receipt; it is
retained and excluded from resource/performance claims, then repeated in the
bounded owned scope. These checks establish integration, rather than relabeling
the earlier paired model/SDK measurements as the rebased runtime.
