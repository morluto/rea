# Android package summary and exact retained manifest

Continues [#2016](https://github.com/morluto/rea/issues/2016) and
[#2438](https://github.com/morluto/rea/pull/2438). The recurring NewPipe question
asks for APK/package/version identity, all case-sensitive MainActivity matches
and all reported onCreate entries, including explicit null DEX descriptors.
Complete package replies delivered decoded manifest text and duplicate upstream
calls unrelated to those selected facts.

## Compatibility and ownership

MCP `inspect_android_package` accepts explicit `detail: "summary"`; omitted and
`"complete"` requests preserve the complete output and provider request. The
one-shot CLI stays complete. Summary selection happens in the application
workflow, independently of the engine protocol, using the existing retained
analysis-view machinery. No third-party plugin API or persistent analysis cache
is introduced. Servers lacking retention reject summary before provider work.

The complete original Evidence stays under its original ID and session lifetime.
A distinct linked derived view returns all package/SDK/permission declarations,
engine identity, class/resource counts and signature-verification status.
Manifest metadata retains the producer's partial/complete status, nullable
reported byte total, and observed UTF-16 length. Text and duplicate raw calls
remain in the original record, rather than being rewritten under its ID.

Use `inspect_analysis_view` with the parent's ID and
`view: {kind: "android", facet: "manifest", offset: 0, limit: 4096}` to read exact
retained decoded text. Follow `coverage.next_offset`; surrogate boundaries use
the existing text-page implementation. Exhaustion describes the retained text,
not global completeness when the producer says partial. APK signatures and
runtime behavior remain unverified. Engine artifact SHA-256 identifies the JAR;
views require the authenticated APK subject and never substitute the engine
hash for a missing target identity. Older servers require schema discovery and
the original complete request; automatic fallback is not introduced.

## Frozen runtime and real SDK pairs

Source runtime: `28c84e78cf2fbfde4aceed345b773c59eb889f68`; later test-only schema
typing corrections do not relabel these receipts. Compiled dist/bridge file-table
SHA-256: `5332dda13981f043e146b3601ebec1f380d9f698280ca53d75786b638a912e11`.
The frozen old runtime is `8bc1601ca51e417ca472d90ea0367e9418a1a0f2`, digest
`9e7380f537301bf0cfe2926f5619011af848af7c220750e75189498e65d825e1`.

Real NewPipe 0.29.1 bytes, acquisition and digest are pinned in `corpus.json`.
Actual configured JADX headless MCP 0.7.1/Java runs use the same selected
provider settings and search-path digests, one worker and 768 MiB Java heap.
Node is 24.18.0; actual SDK client/server are 2.3.1. Processes and engines are
fresh per trial; host page caches are not flushed. SDK schema mode is selected
in both treatments. Heavy runs are serial, with one CPU, unchanged 3 GiB early
stop/4 GiB hard memory, no swap, and 192 tasks.

All four candidate workflows use three successful public MCP calls. Only the
first package delivery changes. Both pairs pass settings and selected-fact
comparison, including all declarations, manifest status/length, engine identity,
original limitations, matching class rows and onCreate entries. Original replies
and IDs remain separate. A fresh old-runtime complete workflow also passes
comparison against the candidate complete request; both complete package replies
are exactly 119,527 compact client-result JSON bytes. This is scoped compatibility
evidence, not a guarantee for every historical release/client/host.

| Trial          | Package reply bytes | SDK workflow seconds | Payload CPU seconds | Kernel peak bytes |
| -------------- | ------------------: | -------------------: | ------------------: | ----------------: |
| sdk-complete-1 |             119,527 |               24.059 |              25.259 |     1,225,076,736 |
| sdk-summary-1  |               8,659 |               23.694 |              24.894 |     1,226,870,784 |
| sdk-summary-2  |               8,659 |               24.407 |              25.611 |     1,228,296,192 |
| sdk-complete-2 |             119,527 |               24.509 |              25.740 |     1,229,844,480 |

Summary replies are 8,659 bytes, about 92.8% smaller; all three replies together
fall from 149,577 to 38,709 bytes. This is a delivery result, not a model-token
or engine-work saving. The SDK timing differences are small. CPU and memory do
not establish a reduction. No provider setting or analysis scope changes.
Transport roundtrip includes server/client work and is not an engine-only timer.

The complete catalog is 2,506,213 compact JSON bytes versus 2,497,635 on the old
runtime: about 0.34% growth, including intervening main changes. Discovery cost
remains visible alongside selected-delivery savings.

## Authentic old Evidence continuation

A real package record from old runtime 8bc160 imports into the candidate and
supports retained summary, exact manifest pages, inline portable summary and
export through actual public SDK tools. The new session explicitly selects an
absent JADX JAR; this workflow performs no package analysis. Eleven successful
calls preserve the original record, original ID, all declarations and all 25,222
manifest UTF-16 units. Manifest UTF-8 SHA-256:
`fee192fe2a6d7892c22cba115184c74c7e2c42ce464e8bb37be6289f2c16881d`.
The exported original record is deeply equal to the imported record.

## Actual Codex task outcomes

Four serial trials run in complete/summary/summary/complete order on the same
frozen candidate. Requested configuration: Codex CLI 0.161.0, `gpt-5.6-terra` high,
three exact selected tool names and the same optional context/discovery capture
settings. The requested alias does not certify the server-resolved model. The
original analyst question is unchanged; equal treatment instructions explicitly
choose package detail and explain the summary carrier. Temporary configuration
points to the frozen modified REA MCP; no global configuration is edited.

| Trial            |   Input | Cached | Uncached | Output | Seconds | MCP calls | Usage records | Facts |
| ---------------- | ------: | -----: | -------: | -----: | ------: | --------: | ------------: | ----- |
| model-complete-1 |  39,267 | 23,040 |   16,227 |  1,690 |  94.053 |         3 |             3 | Pass  |
| model-summary-1  | 128,417 | 93,440 |   34,977 |  3,633 | 150.401 |         8 |             9 | Pass  |
| model-summary-2  |  54,437 | 37,120 |   17,317 |  2,185 | 123.677 |         3 |             4 | Pass  |
| model-complete-2 |  21,332 |  9,984 |   11,348 |    667 |  20.774 |         0 |             2 | Fail  |

Three answers pass the original selected-fact gate against the actual SDK
producer. Each trial preserves APK bytes and removes its isolated profile.
The first summary trial makes five successful calls and three rejected requests:
an invented `case_sensitive` argument, empty class-search input and empty
class-inspection input. It then repeats successful package/search work. These
errors and correction turns remain part of measured task cost; strict existing
schemas correctly reject them. The second summary trial uses the intended three
successful calls, but still does not establish improved total/uncached input or
latency against the factually acceptable first complete control.

The final complete control's first client executor filters `ALL_TOOLS` for the
same three exact names and receives an empty array. It makes zero MCP calls,
reports all requested facts unknown and fails the factual gate. Identical name
filters worked in the other trials. Stderr contains no explanatory error; the
client visibility failure remains unexplained and is not attributed to REA or
summary delivery. Its short duration is not comparable completed work. The
original failed receipt is retained rather than replaced by a successful trial.

These measurements demonstrate no real-model token or speed gain. Smaller raw
MCP envelopes do not establish smaller model context; observed usage also
includes discovery, execution context, corrections and extra responses. Usage
records count captured usage items rather than asserting exact remote request
contents or equating MCP calls with model rounds. The complete default and
opt-in choice remain unchanged; this is useful delivery/retention capability,
not a general performance recommendation.

All model runs have verified payload-completion witnesses with only the observer
remaining and zero memory/task limit events at that phase. Kernel peaks are
602,472,448–1,444,945,920 bytes; the failed no-analysis control is included in that
range and is not evidence of lower analysis memory. Whole-scope final counters
remain unknown and the existing full resource grader stays false. No broader
CPU, memory, OS/provider or model claim is made.

## Resource interpretation

Every SDK run and portable continuation has a verified owned
payload-exited-observer-alive witness, with only the observer remaining and no
memory/task limit events at that phase. Kernel peak and CPU include that opt-in
observer. Whole-scope terminal counters remain unknown; the existing complete
physical resource grader is not changed or called successful. No OOM stress or
resource-limit increase is used.

## Verification and scope

Twenty-seven relevant converted-schema, SDK, domain and existing Android
failure/cancellation/cleanup checks pass. A three-case focused rerun passes after
a test-only schema typing correction. The 1 MiB manifest protocol fixture verifies
original default/full output, reconstruction after source removal, unchanged
exported Evidence and one engine launch. Other cases preserve nulls and partial
status, Unicode boundaries and tagged malformed/missing-identity failures, and
reject unavailable retention or cancelled requests before provider work. These
fixtures verify production boundaries; actual JADX claims use the real NewPipe
runs above. Full supported single-thread compiler and unchanged lint pass under
the same memory safeguards. No other Android OS/device/provider lane is inferred.

Raw SDK/model replies, private profiles and resource receipts stay outside Git.
Reproduce SDK pairs using the existing `measure.mjs` with `--artifact newpipe.apk`,
`--schemas selected`, identical explicit provider configuration and frozen runtime,
and alternating `--delivery complete` / `--delivery summary`. Preserve failed
attempts and run `compare.mjs` on both pair orders. Model findings require their
own identical analyst facts and explicit delivery controls.
