# Unreal pak indexes

`inspect_unreal_pak` (CLI: `inspect-unreal-pak`) reads the footer and index of
one local Unreal Engine `.pak` file and returns every index entry: path,
offset, stored and uncompressed size, compression method, block count and size,
encryption and deletion flags, and the SHA-1 stored with full records. It reads
only the footer and the index regions the footer names, so a multi-gigabyte pak
is inspected without loading it; the whole file is still hashed for artifact
identity. It does not extract, decompress or decrypt file data and starts no
Unreal process.

Pak versions 1 to 12 are decoded. The tool reports the serialized version and
footer layout (`v8a` and `v8b` share version 8) and never attributes a version
to an engine release. The path must name a regular file; symbolic links are
rejected.

## MCP

MCP returns a compact summary by default and retains the complete Evidence in
the session:

```json
{
  "name": "inspect_unreal_pak",
  "arguments": { "path": "/artifacts/Content/Paks/Game-Windows.pak" }
}
```

The summary has the footer, the index facts and `counts` (`entries`,
`encoded_records`, `full_records`, `compressed`, `encrypted`, `deleted`,
`without_path`, `issues`). Select entries without reopening the file. Every row keeps its
original `index` in the pak index; `indices` and `paths` select exact entries,
`fields` selects row fields, and filters intersect before paging:

```json
{
  "name": "inspect_analysis_view",
  "arguments": {
    "source": {
      "kind": "retained-evidence",
      "evidence_id": "<parent_evidence_id>"
    },
    "view": {
      "kind": "unreal-pak",
      "collection": "entries",
      "paths": ["Content/Maps/Entry.umap"],
      "fields": ["offset", "size", "compression_name"],
      "offset": 0,
      "limit": 64
    }
  }
}
```

`detail: "complete"` returns every entry inline.

## CLI

```bash
rea inspect-unreal-pak /absolute/path/Game-Windows.pak --json
```

The CLI defaults to complete Evidence. `--detail summary --evidence_output FILE`
writes the complete Evidence to a new file and returns the summary.

## Observations

- **Footer.** Found by trying each layout's fixed size from the end of the file,
  newest first; the magic and the serialized version must both match. It gives
  the index region and its SHA-1, the index encryption flag (version 4+), the
  encryption key GUID as stored (version 7+), the frozen-index flag (version 9)
  and the compression method names (version 8+).
- **Legacy index (versions 1 to 9).** A mount point, then each path with a full
  entry record.
- **Version 10+ index.** A mount point, the entry count, the path hash seed, the
  locations of the path hash index and the full directory index, a blob of
  bit-packed entries and a list of full records. Paths come from the full
  directory index. Without one, entries are listed from the path hash index
  with `path: null` and their 64-bit `path_hash`. The path hash index region
  also holds a pruned directory index after the hashes; its directory and file
  counts are reported and its references are checked. The header entry count,
  the path hash count, the directory index file count and the decoded entries
  are compared; a disagreement is recorded as an `entry-count-mismatch` issue.
  Directory names must end with `/`, as Unreal writes them. In version 11+,
  when both indexes are present, each directory index path is hashed the way
  `FPakFile::HashPath` does in Unreal Engine 5.8 (ASCII lowercase, UTF-16LE
  code units, FNV-64 with the path hash seed added to the offset basis) and must
  name the same record in the path hash index. Version 10 hashes are not
  checked: Unreal hashes them with legacy FNV constants, repak 0.2.3 writes the
  version 11 hash instead, and no Unreal-written version 10 pak was available.
- **Integrity.** The index, path hash index and full directory index bytes are
  checked against the SHA-1 recorded for them; a mismatch is an issue, not a
  rejection. Every entry's offset plus stored size must end before the index. The per-entry SHA-1 of file data is reported, not
  checked, because file data is not read. Footer fields (compression names, the
  key GUID and the flags) have no recorded hash and are reported as stored.
- **Version 12.** Reported as layout `v12`; its bytes are arranged like the
  version 11 footer. In the directory
  listings, directory names keep the FString form and file names are UTF-8
  byte counts without a terminator; a NUL inside a name is rejected. This was
  observed on a pak written by Unreal Engine 5.8.3.
- **Block facts.** `compression_blocks` and `compression_block_size` are the
  values stored in the index. Unreal Engine 5.8.3 writes a block size of 0 for
  some single-block entries; it is reported as 0, not replaced by the
  uncompressed size.
- **Compression names.** `compression_method` 0 means stored, with
  `compression_name: null`. In version 8+ any other value counts from 1 into the
  footer table (`compression_methods[method - 1]`); a method naming an empty
  or missing slot keeps the entry with `compression_name: null` and an issue.
  Only records a listing references are reported; encoded or full records no
  listing names are walked for their bounds but produce no issue. Before version 8, from the legacy
  flag values (1 `Zlib`, 2 `Gzip`, 4 `Custom`); other legacy values keep their
  raw `compression_method` with `compression_name: null`. Names identify
  methods; no data is decompressed, so they are not codec verification.
- **Encrypted index.** Reported with `index.state: "encrypted"`, the footer
  facts and no entries. No key is accepted and nothing is decrypted.

## Issues

Two facts the pak records separately can disagree while the structure stays
readable. Decoding then continues with the effect the table below gives for
each kind (`entry-count-mismatch`, `unknown-compression-slot`,
`malformed-directory-name` and `path-hash-mismatch` make a fact null), and `issues` records each contradiction once with its `kind`, the
file `offset` of the record that shows it, and a `message`:

| Kind                       | Offset                                 | Effect                                                                |
| -------------------------- | -------------------------------------- | --------------------------------------------------------------------- |
| `region-hash-mismatch`     | Start of the region                    | The region's bytes are decoded unverified.                            |
| `duplicate-path`           | The repeated path name or path hash    | Every entry is kept in index order; a path no longer names one entry. |
| `entry-count-mismatch`     | The index header entry count           | `index.entry_count` is null; each listing keeps its own count.        |
| `unknown-compression-slot` | The entry record naming the empty slot | That entry's `compression_name` is null.                              |
| `malformed-directory-name` | The directory name                     | Entries listed under it keep `path: null`.                            |
| `path-hash-mismatch`       | The directory index file name          | That entry's `path` is null.                                          |

The summary counts issues, and `inspect_analysis_view` collection `issues`
selects them by `indices`, `kinds` and `fields`, each row with its source
`index`. An empty list means every checked redundant fact agreed, not that the
file data is intact. An encrypted index is not read, so none of its facts are
checked and `issues` is empty; `index.state: "encrypted"` tells that case apart.

## Failures

Structure that cannot be trusted for further reads is rejected with a reason
and no partial success: offsets and sizes outside the file, truncated records,
references that name no record, and counts above the resource limits.

| Reason                         | Kind        | Meaning                                                                                 |
| ------------------------------ | ----------- | --------------------------------------------------------------------------------------- |
| `unrecognized-footer`          | unsupported | No pak footer layout matches the end of the file.                                       |
| `frozen-index`                 | unsupported | Version 9 frozen indexes store a serialized memory image.                               |
| `region-out-of-bounds`         | corrupt     | An index region ends past the footer or a 64-bit value exceeds the safe integer range.  |
| `truncated-record`             | corrupt     | A record or declared block list ends past its region.                                   |
| `invalid-string`               | corrupt     | A string lacks its terminator or is not valid UTF-8.                                    |
| `invalid-flag`                 | corrupt     | A boolean field is neither 0 nor 1.                                                     |
| `index-trailing-bytes`         | corrupt     | The index or a listing region has bytes after its last record.                          |
| `entry-reference-out-of-range` | corrupt     | A directory or path hash entry names no record start.                                   |
| `entry-out-of-bounds`          | corrupt     | An entry's stored bytes would end past the data area.                                   |
| `region-too-large`             | resource    | The index regions read for one pak exceed 256 MiB together.                             |
| `too-many-entries`             | resource    | An index declares more than 1,000,000 entries.                                          |
| `paths-too-large`              | resource    | The mount point and paths would exceed 67,108,864 UTF-16 code units, the report budget. |

Long index decodes yield every 4,096 records and stop there when the request is
cancelled. Each reader admits one inspection at a time. A reader failure after
the whole file was read and hashed keeps that SHA-256 and byte length as partial
source Evidence, which does not establish any footer or entry fact. A
cancellation observed after the reader returned its complete report keeps the
decoded report as partial Evidence.

The complete report is limited to 64 MiB. It is refused from the declared entry
count before entries are built when even minimal rows would exceed it; that
refusal comes before the file is hashed, so it keeps no partial Evidence. A
finished report above the limit is refused after hashing and keeps the hashed
source identity only. There is no partial success.

`region-too-large` and `too-many-entries` report resource `file-size` with
`maximum_region_bytes` and `maximum_entries`. `paths-too-large` reports
resource `transport` with `maximum_output_bytes` and
`maximum_path_utf16_units`, because path text is report text.

The 256 MiB region limit is shared: the index, the path hash index and the full
directory index count against one total, because all three can be held at
once. Decoding also keeps one listing's file rows, the path hash table and the
returned entries; peak memory has not been measured.

## Outside this tool

- Extracting, decompressing or decrypting file data, and accepting keys.
- IoStore containers (`.utoc`/`.ucas`) and `.uasset` contents.
- Attributing a pak version to an engine release.

## Real producer verification

`npm run verify:unreal:pak -- --pak PATH` compares the CLI with stdio MCP for a
caller-owned pak and checks summary and page parity. Pak files from games are
not redistributable, so CI uses synthetic fixtures.

The version 12 layout was checked against a pak written by Unreal Engine 5.8.3
for a blank Mac project (Oodle, 1,722 entries, 10,473,434 bytes, SHA-256
`64c5f36e0c87573dde851109526b34bc0abaf0c7d1c2f66c99efba26b3614f9b`). The
verifier passed, repak 0.2.3 listed the same 1,722 paths, and CUE4Parse matched
every entry offset, stored size, uncompressed size, block count and encryption
flag. CUE4Parse replaces a stored block size of 0 with the uncompressed size, so
the 350 entries stored with block size 0 differ by that substitution only.
Separately, 46 generated paks (versions 1 to 11 with no compression, Zlib, Gzip,
LZ4 and Zstd) matched the entry offsets, sizes, block counts, block sizes and
encryption flags that repak read from them.

These checks do not establish coverage of paks from other engine releases,
platforms or game-specific forks, of encrypted indexes with real keys, or of
version 12 paks written with other options. Matching index facts do not
establish that the file data decompresses or that a stored SHA-1 matches its
data, because neither is read.
