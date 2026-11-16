# Android binary XML decoding

## Problem and outcome

APKs carry `AndroidManifest.xml` and layout resources as compiled binary XML
(AXML), not text. REA saw the `RES_XML_TYPE` carrier but could not report what
it declares, so component names, permissions and attributes stayed opaque.
`inspect_artifact` now admits a standalone AXML document or one embedded in a
ZIP member and `extract_artifact` writes a deterministic `document.xml`
projection, without running any Android tooling.

## Requirements

- Recognize the `03 00 08 00` preamble and the little-endian `RES_XML_TYPE`
  header; the declared document size bounds the chunk walk.
- Parse the `ResStringPool` chunk, including UTF-8 and UTF-16 strings,
  extended-length encodings, style counts, offset tables and bounds. Reject
  damaged records: missing terminators, inconsistent UTF-8 length fields and
  characters XML 1.0 forbids.
- Parse the optional resource map, retaining only the prefix addressable by
  pool string indices.
- Parse namespace start/end chunks, start/end elements, attributes, CDATA and
  node comments. Track namespace scope bidirectionally so a shadowed or
  expired prefix is never emitted against the wrong URI; honour the predefined
  `xml:` binding. Drain pending declarations linearly.
- Require exactly one root element, reject duplicate expanded attribute names,
  non-whitespace character data outside the root, unbalanced trees and
  `attrStart` extents that overlap fixed fields.
- Render typed values by type: strings, references (`@`) and attributes (`?`)
  including dynamic kinds, floats, dimensions and fractions, decimal/hex
  integers, booleans and width-appropriate colours (`#AARRGGBB`, `#RRGGBB`,
  `#ARGB`, `#RGB`). Preserve string bytes exactly, including leading U+FEFF.
- Keep unresolved resource IDs numeric; resource-table names stay a documented
  limitation.
- Skip unrecognised chunks inside the declared extent but never claim their
  coverage; report skipped counts and unexamined carrier bytes as limitations.
- Bound admission, pool retention, depth, element/attribute/namespace counts
  and projected output with typed `format` versus `limit` failures.
- Expose one extractable region, `document.xml`, plus document metadata
  (string/style counts, UTF-8 flag, resource-map size, element/attribute/
  namespace counts, declared size).

## Acceptance

Synthetic fixtures cover round-trip documents, every typed value, namespace
scoping, malformed pools, truncated chunks, over-bound inputs and tampered
declarations. Boundary tests cover CLI inspection/extraction and MCP
`inspect_artifact`. A real APK manifest (com.dragon.read 7.4.3.32) decodes to
well-formed `document.xml` with 1,927 resolved `android:` references.

## Out of scope

Resolving `resources.arsc` names (covered separately), layout XML beyond the
manifest, and any execution or installation of the APK.
