# Android binary XML (AXML)

`inspect-artifact` and `extract-artifact` decode Android binary XML documents —
the compiled form of `AndroidManifest.xml` and resource XML inside APKs —
without running apktool, JADX or Android tooling. The document opens with an
8-byte `RES_XML_TYPE` header (chunk type `0x0003`, header size 8, declared
document size), followed by a string pool, an optional resource map, and the
namespace, element and CDATA chunks of the document tree. All multi-byte
fields are little-endian.

Decoding renders the deterministic XML text as one `document.xml` region.
Element and attribute names come from the declared string pool; the resource
map supplies `android:` prefixes for names declared without a namespace URI,
and an attribute's namespace URI resolves through the document's own
`xmlns` declarations. Typed attribute values render literally: integer, hex,
boolean, `@0x…` references, `?0x…` attributes, colors, dimensions and
fractions. Raw string values declared on an attribute win over its typed
value, matching producer output.

Inspection retains document facts: string, style, element, attribute and
namespace counts, the string pool encoding flag, the resource map count and
the declared document size. The decoded region carries its own counts and
byte length. Carrier freshness is checked when the region is opened; reader
close cancels and joins outstanding streams before releasing its descriptor.

No semantic interpretation is applied: resource table (`resources.arsc`)
names are not resolved, references stay numeric, DEX identifiers are not
followed and component semantics — permissions, exported state, deep links —
remain declared text, not effective behavior. Standalone documents only;
an `AndroidManifest.xml` member inside an APK is decoded when extracted as
its own artifact.

## Resource bounds

The decoder admits documents up to 64 MiB, retains at most 256k strings and
16 MiB of string data, walks at most 256k elements, 1M attributes, 32k
namespace declarations and 4096 nesting levels, and emits at most 32 MiB of
XML text. Counts, spans or output beyond those bounds are typed `limit`
failures with the `capacity` boundary; the declared-file bound reports the
`file-size` boundary. Chunk extents outside the declared document, a missing
or duplicated string pool, truncated records, out-of-pool name or value
indices, unclosed or mismatched elements and impossible header or size
fields are malformed-input `format` errors. A carrier shorter than its
declared document keeps its format identity with unknown coverage.
