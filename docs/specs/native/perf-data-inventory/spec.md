# Linux perf.data inventory (#8143)

## Outcome and scope

Inventory one explicitly selected Linux `perf.data` recording offline, without a
Linux host, a `perf` installation or the recorded process. This is a read-only
producer within existing artifact-inspection authority: it opens only the
selected file, executes nothing and contacts nothing.

The scope is the file header, the attribute and data section extents the header
declares, and one row per event attribute group. Feature payloads, sample
records, callchains, symbols, build identities and restore-time attribution are
out of scope and stay stated as not decoded.

## Contract

Every fact id binds to the artifact digest, so two recordings with the same
offsets and layout keep distinct event, diagnostic and recording ids, and a
diagnostic id additionally binds the allowance it was produced under.

Byte order comes from the magic: `PERFILE2` as written and its reverse are both
accepted, and the chosen order drives every read. The `freq` flag is a C
bitfield; a big-endian host writes it at numeric bit 53 and `perf` reorders it
with `swap_bitfield`, so the raw big-endian word is mirrored before the
little-endian mask applies.

Declared extents are reported with a `within_file` flag instead of being
clamped, so an out-of-range section stays visible. An identifiers extent that
is not a whole number of 8-byte identifiers, or that does not fit the file, is
reported as `invalid-ids-section` and marks the identifier inventory
incomplete rather than reading part of it as the whole.

Allowances are caller-selected and bounded: `max_events` bounds the attributed
groups and the retained identifier count is bounded independently across
entries, so an archive of entries pointing at one large extent cannot grow the
inventory without a limit. Hitting either bound is reported as a diagnostic and
makes coverage partial; it never reports as complete.

## Evidence and coverage

An identifier above JavaScript's safe-integer range is still an identifier, and
an unreadable or truncated ids extent is not an empty one. Any such entry
clears `summary.identifiers_present` and raises a diagnostic, so a short list is
never published as the whole list.

Each event group states whether an ids extent made its declared period a
frequency or a period, and retains the declared attribute size. A non-perf file
reports what was observed and a null header rather than a fabricated magic,
byte order or size. A file short enough that every byte it carries matches one
of the two magic spellings is a truncated recording rather than unrelated
input, and is reported as such.

## Authority and overlap

An attribute extent that reaches into the declared file header is reported as
`header-attribute-overlap`, which names the header rather than claiming the
attribute and data extents collide. An `attr_size` above JavaScript's
safe-integer range is reported as `unsafe-attribute-size`, and
`file_header.attribute_bytes` stays null rather than publishing a stride of
zero that the file did not state.

Reads the selected local file only. CLI accepts a local path; MCP requires an
absolute path on the current host. No provider is contacted and no target is
executed or replayed. Delivery is the complete inventory: this operation has no
summary reader, so the CLI advertises `--detail complete` only.
