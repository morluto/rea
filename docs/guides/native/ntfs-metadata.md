# Acquired NTFS metadata and change journals

Use offline acquisitions of the logical `$MFT` stream and `$UsnJrnl:$J`
stream from the same volume. REA reads the selected files without mounting a
volume, following data runs, querying Windows, or replaying journal operations.
Pairing the acquisitions is the caller's responsibility.

```bash
rea inspect-artifact ./MFT --json
rea inspect-ntfs-journal ./MFT ./UsnJrnl-J --maxRows=50 --json
```

MCP accepts absolute local paths:

```json
{
  "name": "inspect_ntfs_journal",
  "arguments": {
    "mft_path": "/artifacts/MFT",
    "journal_path": "/artifacts/UsnJrnl-J",
    "max_rows": 50
  }
}
```

The paired workflow admits at most 64 MiB per acquisition. Its Evidence records
both paths, lengths and SHA-256 digests. Keep the acquisitions and compare both
digests between pages. Offsets refer to those original files, whose bytes remain
unchanged; sector fixups are restored only in a scratch record before attribute
interpretation.

`mftMetadata` reports aggregate inventory and fixup coverage, and at most 32
record details when requested with `mft_record_limit` / `--mftRecordLimit`
(default 0, inventory counts only). Names retain their individual parent references, namespaces,
FILETIMEs, sizes and flags; several names are not collapsed into a path. Standard
information timestamps stay separate from filename timestamps. All 64-bit times
and sizes use decimal strings. Resident attributes retain value spans;
nonresident attributes retain sizes, VCN ranges and validated packed mapping
pairs, including sparse and fragmented runs. Attribute-list entries retain full
references and IDs.

For a selected base record with attribute lists, `attributeListResolution`
checks references inside the same acquired MFT. A link requires the exact
record/sequence identity, verified fixups, matching base reference, and matching
attribute type, name, ID and lowest VCN. `linkedAttributes` and
`linkedFileNames` carry additional extension facts with original source offsets;
local physical-record attributes stay separate. Global counts and
`fileNameCoverage` describe physical-record walks, without double-counting
linked facts.

Each detail page shares a budget of 32 additional decoded records (at most
2 MiB of source record bytes), and each base record delivers at most 32 reference
results. This bounds decoding and delivery, not total process memory.

- `references` identifies source list entries and reports resolved attribute
  offsets, ambiguity counts, or concrete unresolved reasons.
- `knownEntryCount` counts entries discovered in available resident lists.
  `omittedKnownEntries` counts their undelivered results. Unreadable lists or
  omitted references may hide further entries; these are not whole-file totals.
- `unreadListAttributeOffsets` marks list values unavailable from the acquired
  records. Zero known entries does not prove an empty list when this is nonempty.
- `incompleteRecordIndices` preserves partial local walks. A valid referenced
  prefix can remain available while overall link coverage is incomplete.

List graphs are visited by source identity, including cycles. Reused sequences,
contradictory headers, wrong base ownership and ambiguous attributes remain
unresolved. If an additional-record budget is exhausted, reduce the detail page
size or inspect the referenced slot directly with `mft_record_start`. Original
list entries remain in attribute metadata when reference results are omitted.
Nonresident list values and file contents require data outside the supplied MFT
and remain unavailable here.

Journal rows follow acquisition order. V2 records use full 64-bit MFT references,
including sequence numbers. Reused, inconsistent and unverifiable identities
remain unresolved. V3 and V4 contain opaque 128-bit IDs, represented losslessly
as unsigned little-endian decimal values with `referenceBytes: 16`; they are not
joined to 64-bit MFT identities. V4 records carry no timestamp or name, so those
fields are `null`. Their inline extent sample contains at most 16 entries, with
source offsets, exact signed values, total and omitted counts, and
`remainingExtents` for the recorded continuation state.

Follow `nextFileOffset` with MCP `start_file_offset` or CLI `--startFileOffset`.
Decoding starts exactly there; preceding bytes are not examined. For another
MFT detail page, select a limit from 1 to 32 and pass `mftMetadata.next_record_header_index` as MCP
`mft_record_start` or CLI `--mftRecordStart`. MFT pages and journal pages are
independent. Use the journal byte length as its starting offset when only MFT
details are needed. A `null` continuation means that view has no further page.

Padding, unsupported versions, malformed records and truncation remain coverage
rows. A bad record with a valid declared length can be skipped; a length that
cannot locate the next record stops journal decoding. `historyCompleteness`
remains `unknown`: supplied bytes alone cannot establish missing captures,
wrap, absent rename partners or a complete activity history. Multiple reasons,
rename rows and parent changes remain distinct source facts.

Verification covers synthesized paired acquisitions,
[unmodified Windows 11 MFT records through the packaged Linux CLI](../../verification/ntfs-metadata-2026-11-11.md),
and [paired V2 streams from a public NTFS volume fixture checked against an independent parser](../../verification/ntfs-metadata-2026-11-11.md#paired-volume-fixture-verification)
through CLI/MCP on Linux. The fixture's original acquisition provenance, real
V3/V4 captures and Windows-host execution remain unverified. Nonresident payload
recovery is outside implemented scope. Real extension-record captures remain
unverified.

Format references: [Microsoft USN V3](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-usn_record_v3),
[USN V4](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-usn_record_v4),
and [Linux NTFS on-disk definitions](https://github.com/torvalds/linux/blob/master/fs/ntfs3/ntfs.h).
