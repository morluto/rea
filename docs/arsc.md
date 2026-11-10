# Android compiled resources (resources.arsc)

`inspect-artifact` and `extract-artifact` decode Android compiled resource
tables — `resources.arsc` inside APKs — without running apktool, aapt or
Android tooling. The table opens with a `RES_TABLE_TYPE` header (chunk type
`0x0002`, declared document size, declared package count), followed by the
global string pool and package chunks carrying their own type and key string
pools, type specs, and typed entry records. All multi-byte fields are
little-endian.

Decoding renders a deterministic XML projection as one `resources.xml`
region: each package by id and name, each type chunk by id, name and decoded
configuration qualifier (`default`, `en-rUS-480dpi-v35`, …), and each entry
by its resource id, key-pool name, `public` flag (from the type spec) and
literal value. Complex bag entries project their parent reference and item
map. String values resolve through the table's own global string pool;
typed values render exactly as the AXML decoder renders them — integer, hex,
boolean, `@0x…` references, `?0x…` attributes, colors, dimensions and
fractions — and `TYPE_DYNAMIC_REFERENCE`/`TYPE_DYNAMIC_ATTRIBUTE` resolve
to their `@`/`?` forms.

Inspection retains table facts: package, type, entry and global string
counts plus the declared document size. The decoded region carries its own
counts and byte length. Carrier freshness is checked when the region is
opened; reader close cancels and joins outstanding streams before releasing
its descriptor.

No semantic interpretation is applied: resource values are projected, not
evaluated; `res/…` file references stay literal text; library, overlayable,
overlayable-policy and staged-alias chunks are walked but not projected and
reported as limitations; sparse entries (`NO_ENTRY`) simply do not appear.
Standalone tables only; a `resources.arsc` member inside an APK is decoded
when extracted as its own artifact.

## Resource bounds

The decoder admits tables up to 64 MiB, retains at most 1M strings and
64 MiB of string data per pool, walks at most 256 packages and 1M entries,
and emits at most 96 MiB of XML text. Counts, spans or output beyond those
bounds are typed `limit` failures with the `capacity` boundary; the
declared-file bound reports the `file-size` boundary. Chunk extents outside
the declared document or their package, missing string pools, type or key
indices outside their pools, truncated entries or value records, package
ids outside the one-byte space, and impossible header or size fields are
malformed-input `format` errors. A carrier shorter than its declared
document keeps its format identity with unknown coverage.
