# [Feature] Read Android binary XML documents and compiled resource tables

## Before submitting
- [x] I searched the open and closed issues and pull requests for a related proposal.
- [x] I understand the contribution scope must be reviewed before integration; open questions are welcome here.
- [x] This request does not include credentials, private samples, or sensitive target data.

## Area
Evidence, artifacts, or reconstruction

## Current limitation
`inspect-artifact` treats an Android binary XML document (the compiled `AndroidManifest.xml` inside every APK, binary layout resources under `res/`, split manifests) and a `resources.arsc` compiled resource table as opaque `file`s. Both share the RES_XML/RES_TABLE chunk-stream container: a resource-table header, a UTF-8/UTF-16 string pool with optional spans, and typed chunks carrying start/end namespace and element records or package/type/entry maps. Today an analyst must leave the Evidence workflow and run apktool or androguard just to recover the manifest's package/permissions/components or the table's package→type→entry projection, and the decoded XML text is never classified, hashed, or compared as artifact content.

## Use cases
APK triage and diffing routinely starts at the manifest and resource table: they declare the entry surface (activities, services, providers, permissions) and the resource identity space without running the DEX. During review of an Android target I decoded `AndroidManifest.xml` and `resources.arsc` by hand to reach exactly the facts these readers would surface in the manifest graph. Both formats are publicly documented and independently re-implemented, so decoded output is easy to cross-validate against aapt2/apktool on the same sample.

## Desired outcome and success criteria
- `inspect-artifact` on a binary XML document reports `format: axml` with chunk-stream facts (string/style/resource-map counts, element/attribute/namespace counts, declared size) and a `document.xml` occurrence carrying the decoded XML text.
- `inspect-artifact` on a resource table reports `format: arsc` with package/type/entry/string counts and a decoded XML projection of the table as an `arsc-document` region.
- `extract-artifact` materializes the decoded XML byte-identically under the occurrence path.
- Malformed chunk streams, truncated string pools, out-of-bounds offsets and oversized expansion produce typed refusals, not partial output; bounded decoding charges an expansion budget before allocation.
- Verified against real producer samples (aapt2-compiled manifest/resources), cross-checked against an independent decoder.

## Expected interaction with targets
Read existing files or captured data

## Target and scope details (optional)
Non-goals for this request: DEX interpretation, resource-name resolution against `resources.arsc` inside AXML rendering (the two readers remain independent), overlay/staged-alias/library chunk projection (walked but not projected), runtime resource resolution, and APK container changes (the existing zip/apk inventory already reaches these members). No decryption, execution, or live-device acquisition.

## Verification available so far
I can suggest a sample or manual check

## Verification details (optional)
Format layout is publicly documented (AOSP `ResourceTypes.h`) and re-implemented by aapt2, apktool and androguard; decoded XML and table projections can be compared field-for-field against an independent decoder on the same sample, the same methodology used for the wxapkg reader. Synthetic chunk streams covering both happy paths and malformed boundaries are already exercised in the reader boundary tests.

## Alternatives considered
Apktool decodes both formats but rewrites rather than preserves (namespace aliasing, attribute reordering), runs as a heavyweight external toolchain, and produces loose files without REA's manifest graph, hashes, coverage reporting, or nested-artifact classification. Androguard is a library but Python-bound. Treating the members as opaque files (current behavior) loses the decoded content entirely.

## Possible direction
Follow the wxapkg/UnityFS reader shape: bounded chunk-stream parse with per-chunk bounds before allocation, string-pool decode honoring UTF-8/UTF-16 and span counts, element records projected to XML text through a bounded writer, table package/type/spec/entry chunks walked into an XML projection, unavailable-style retention for undecodable chunks, and format recognition on the RES_XML_TYPE (0x0003) / RES_TABLE_TYPE (0x0002) headers before the archive container.

## References
- AOSP format definition: `frameworks/base/libs/androidfw/include/androidfw/ResourceTypes.h` (chunk types, string-pool flags, element/attribute records, table package/type/entry layouts)
- Independent decoders for cross-validation: aapt2 compile/link output, apktool, androguard `axml`/`arsc` modules
- Prior integration precedent in this repository: wxapkg reader, UnityFS reader (#7699), Godot PCK reader
- Implementation PRs: #9590 (AXML), #9798 (ARSC, stacked on #9590)
