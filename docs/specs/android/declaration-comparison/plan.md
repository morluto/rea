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

## Verification

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
