# Implementation plan

The Android producer owns declaration interpretation. A domain comparison uses
only its typed normalized facts. A shared application workflow authenticates the
inspection envelopes, admits the recorded APK identity and path selection, resolves
declared retained inputs, and creates derived Evidence linked to both exact sources.

The canonical contract owns input and output schemas and truthful additive Evidence
effects. CLI document and MCP bindings call the same workflow. Existing retained
source recording and explicit CLI bundle ownership handle provenance and cleanup.

Component groups retain occurrences rather than overwriting duplicate names.
Unknown fields and inventory gaps stay explicit. Permission observations are
deliberately separate from covered component changes because the producer does
not declare permission-list completeness. Source manifests remain accessible
through their Evidence references and are not duplicated in comparison output.

Source resolution uses the canonical Evidence-input admission hook. Ordinary
JSON validation and complete source headroom precede cloning and authentication;
the Evidence owner alone supplies immutable authentication proof. Android payload
validation has its own preflight and caches only exact validated immutable roots
with weak keys. Source display metadata is read from each selected envelope,
never cached by Evidence ID. Cancellation is checked before this work starts.

The export comparison combines independent declaration and default facts. Known
differences remain changes; unknown facts cannot establish equality or create a
difference. A separate unresolved-attribute fact retains partial coverage even
when a known declaration difference establishes a changed component.

## Initial feature verification

Verified on 2026-11-16 with Node 24.22.1 and npm 11.16.0:

- All 11 focused semantic, application and public CLI/MCP tests passed, including
  retained-source recovery, uncertainty, compact advertised output validation and
  pre-grouping capacity admission.
- `npm run check:fast` passed, including architecture guards.
- The compiled CLI ran real JADX headless MCP 0.7.1 on two self-authored binary
  AndroidManifest APKs compiled with the installed aapt. OpenJDK 21 included
  `jdk.compiler`; the selected engine JAR matched SHA-256
  `6e5eacf500b64292bfb73c49797c1958f6ee44646e43e868039ae7feb573ff75`.
  Both APK byte identities were retained and matched the independently parsed
  aapt inputs. The observed result was target SDK 35 to 36, CAMERA observed only
  on the right, MainActivity exported false to true, one added UploadService and
  changed StoreProvider authorities. Component counts were one added, two
  changed, one unchanged and zero unknown. Inline and portable-bundle requests
  produced the same derived Evidence and exact source links.

The manual samples use `hasCode=false` and contain no DEX. They verify actual
static extraction and comparison, with no APK installation, target execution,
business-code or runtime-access claim. The automated semantic tests separately
cover malformed, partial and ambiguous inputs.

A combined local build also passed eight real stdio MCP calls and three compiled
CLI parity commands: two actual JADX inspections, retained-ID comparison,
incoming-link queries for both exact sources, and complete bundle export. The
CLI reused that same bundle and produced the identical derived comparison ID
and incoming-link rows. This additionally verifies the source handoff to the
companion Evidence referrer selector.

The 82 capability-declaration conformance tests and all eight README consistency
tests passed. `npm run docs:check`, test discovery, and all configured advertised
schema engines passed (four catalogs, 31 patterns, 253 distinct schemas). The
complete `npm run check` remains blocked by the same pre-existing knip findings
independently reproduced on the unmodified base: one unused file, five unused
exports, two unused exported types and one duplicate export, outside this diff.
It is not reported as a passing complete repository static gate.

## Review corrections and validation

The source-memory review identified authentication and Android-schema copies
before the original comparison-output admission. The canonical Evidence resolver
now admits complete mutable sources before authentication. Ordinary JSON is
checked without cloning first; raw results, parameters, manifest text and full
component trees are included in headroom accounting. The Evidence owner exposes
its existing immutable authentication proof without changing the boolean
ownership contract used by sibling consumers. Selected immutable payloads are
validated once and borrowed only after exact parsed-snapshot comparison. Weak
keys bind reuse to the immutable payload lifetime; source display choices remain
on the selected envelope. Queued cancellation precedes lookup and source work.

The default-comparison review identified an OR-based knownness check that let a
known exported literal make an unknown default appear comparable. Declaration
and default facts now compare independently. Known differences establish a
change; unknown defaults alone establish neither difference nor equality. A
separate unresolved-attribute fact keeps coverage partial when a known literal
difference and an unknown default coexist. Omission versus explicit declaration
remains distinct when established by the producer.

Correction validation used the same pinned toolchain and engine:

- The nine-file focused run passed all 91 semantic, source-admission, Evidence
  ownership, request-resolution, MCP-input and compiled CLI/MCP acceptance tests.
  Controlled headroom cases reject complete sources before clone/hash and retain
  format validation, tamper rejection, metadata borrowing and queued cancellation.
- The pre-fix compiled server and CLI reproduced unknown-versus-known defaults
  as changed and unknown-versus-unknown as unchanged from actual JADX inspections.
- Four new self-authored aapt-compiled APKs retained a `FutureDessert` target SDK
  string, explicit exported true/false and known authorities. Actual JADX 0.7.1
  returned complete declarations with unknown provider defaults. The corrected
  compiled stdio server passed eight MCP calls and three CLI parity commands:
  the two unknown-default comparisons now remain unknown/partial, while the
  known literal change remains changed/partial.
- A separate combined runtime repeated the original two-APK comparison and
  Evidence-referrer handoff: eight MCP calls and three CLI commands passed, with
  known SDK/permission/component changes and source links unchanged.
- `npm run check:fast`, `npm run docs:check`, test discovery and scoped typed lint
  passed. All configured advertised-schema engines accepted 31 patterns and 253
  distinct schemas across four catalogs; no schema summary changed.
- The full `npm run check` still stops at the independently established base
  knip findings listed above, with no additional findings in these changes.

The capacity regressions use controlled available headroom rather than inducing
a process OOM. Real samples remain resource-only APKs without DEX, installation
or target execution; no physical OOM stress or business-application coverage is
claimed. No directly related APK cleanup remains.
