# NTFS $MFT and USN Journal inspection

This specification records an implementation increment and its original problem
statement. For current behavior and limitations, see the
[NTFS workflow guide](../../../guides/native/ntfs-metadata.md).

## Problem and outcome

REA has no reader for acquired NTFS metadata artifacts. An analyst holding a
captured `$MFT` stream cannot ask which FILE records it contains, whether their
update-sequence fixups survived acquisition, or which records are directories,
extensions of another record, or no longer in use. Add offline, read-only
inventory of a selected `$MFT` file, delivered in steps so each one merges on
its own.

## Requirements

- Recognize a `$MFT` stream by a plausible first `FILE` record header under
  any file name. CLI and MCP target admission route it to the artifact reader.
- Validate each FILE record header: the `FILE` signature, sequence number, flags,
  used and total byte counts, base record reference, and the update-sequence
  array's offset, count and array bounds.
- Verify the update-sequence fixups: every sector trailer the array covers must
  hold the array's sequence number. A mismatch keeps the record's header facts
  and is reported per record and in the metadata count.
- Report a missing, misplaced or short update-sequence array as unverified
  rather than as a clean record, and a trailing partial record as a byte count.
- Report the first invalid record signature and the number of invalid slots.
  Continue at the next slot when the stream declared a supported record size.
  With a fallback record size, stop at the first invalid signature.
- Bound the whole file at a fixed 512 MiB ceiling and report the ceiling as a
  `limit` failure with its boundary.
- Return the first 32 decoded record headers with their source offsets and the
  number of omitted headers. Aggregate counts cover the full parsed stream.
- Restore verified sector trailers in a per-record scratch buffer before
  scanning attributes. The domain decoder retains resident `$FILE_NAME`
  names, namespaces, parent references and source offsets. Report incomplete
  coverage when the walk cannot finish or an attribute list may refer to
  extensions. The first 32 record samples expose individual names, parent
  references, namespaces, FILETIME values, sizes and attribute bits. Keep each
  name attribute separate, including multiple names for one record.

- Resolve a selected base record's resident attribute lists only within the
  supplied MFT. Require full sequence/slot identity, verified fixups, base
  ownership and exact attribute type/name/ID/VCN. Preserve physical and linked
  facts separately, including each source offset.
- Share at most 32 additional record decodes per detail page, and deliver at
  most 32 reference results per base. Preserve discovered-entry omissions,
  unavailable list values, ambiguity and partial record facts. Visit list source
  identities once, including cyclic graphs. Nonresident volume payload recovery
  remains outside the acquired-metadata boundary.

## Acceptance

Synthesized fixtures cover a clean record, a failed fixup, a missing update
sequence array, an array shorter than the record's sector count, extension and
directory records, a record whose signature is wrong mid-stream, a trailing
partial record, an undeclared record size, a 4 KiB record, a stream shorter than
one header, bytes without the `FILE` signature, and the file-size ceiling.
Inventory tests cover the root occurrence's metadata and the coverage status
when a fixup fails, and classification tests cover several file names for the
same bytes.

The paired acquisition workflow is available through
`rea inspect-ntfs-journal ./mft ./journal --maxRows 50 --json` and MCP
`inspect_ntfs_journal` with `mft_path` and `journal_path`. Select an acquired
logical MFT stream and the journal data stream from the same volume. Each
file has a 64 MiB working-set admission limit. Follow `nextFileOffset` as
`start_file_offset` on MCP or `--startFileOffset` on CLI and compare the two
input digests between pages.

USN V2, V3 and V4 records are supported. V3/V4 opaque IDs remain unresolved
against MFT references; V4 delivers bounded extent samples with omission counts.
Both the journal events and the MFT metadata have independent continuation
positions. Padding, malformed records and truncation appear as coverage rows.
Record order follows the acquisition, and history completeness remains unknown.

Automated CLI/MCP workflow tests use synthesized acquisitions. Real Windows 11 MFT
records were inspected through the packaged Linux CLI; see the
[verification record](../../../verification/ntfs-metadata-2026-11-11.md).
Paired V2 streams from a public NTFS volume fixture also passed CLI/MCP
verification against an independent parser. The fixture's original acquisition
environment and Windows-host execution remain unverified.

## Page reuse lifetime

Use one MCP session for multi-page traversal. Its shared acquisition scope keeps
one successful digest-bound pair and MFT/reference lookup, validates selected
file state before each reuse, refuses changed/unverifiable sources, and clears
retained data at scope shutdown or pair eviction. Failed acquisitions are not
cached. Each fresh CLI process reacquires its inputs. See the
[completed-task comparison](../../../verification/ntfs-journal-paging-2026-11-11.md)
for measurements, lifecycle regressions and verification limits.
