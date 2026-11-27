# UnityFS AssetBundle archives

`inspect-artifact` and `extract-artifact` read standalone UnityFS AssetBundle
containers without running Unity or the producer application. Header format
versions 6 through 8 are supported. Version 9 adds a different block-table
layout and is unsupported until independently verified.

## Header and members

Inspection retains the format version, player and engine version strings,
declared size, dataflags, blocks-and-directory table bounds, the producer's
16-byte data hash as declared, and the resolved data-area offset. Desktop
application inspection uses the same header bounds; when its initial file probe
stops before both version strings and the fixed fields, the normal probe budget
applies to the additional bytes.

Members (`CAB-*` SerializedFiles, `.resS` resource streams, shared assets)
retain declared source paths, virtual stream offsets, sizes and raw node flags.
The directory flag identifies directories. `compare_artifacts` compares each
member's declared `source_path` and raw `flags`; its index and offset are
layout. Virtual offsets are not physical carrier locations, so member
`source_location` is null.

Member reads examine only their covering blocks. Uncompressed ranges stream
directly; compressed ranges reuse at most one completed decoded block, and
independent 64 KiB output chunks preserve cache ownership. Carrier freshness is
checked when a member is opened, including when a cached block suffices, and
after its stream completes. Closing the reader cancels and joins outstanding
streams before releasing its descriptor.

## Compression, encryption and malformed input

Data blocks and blocks-info tables compressed with none, LZMA, LZ4 or LZ4HC are
supported. Other compression values keep the directory when possible and report
unsupported coverage or an `unavailable` member read.

UnityFS writers emit one LZMA block for a whole data stream, so a large LZMA
bundle is often one block. A block above the per-decode budget below keeps the
directory: only members inside that block report an `unavailable` read naming
the budget, which this release cannot raise. An LZMA dictionary sizes only
the decoder window, which is bounded by the block's declared output, so a large
dictionary on a small block decodes. A stream may end at its declared size or
with an end marker; any other trailing bytes are malformed.

Bundles declaring asset-bundle encryption keep their header facts but report
unknown directory coverage; no decryption is attempted. The reused 0x200
encryption/padding flag is interpreted by producer revision, and ambiguous
revisions retain unknown layout coverage. Unread block counts and data offsets
are null, never invented zeroes.

These are malformed-input errors: a declared size that exceeds the input file
or excludes its header, directory or data blocks; node paths outside the block
stream; and counts that cannot fit their table. Directory and data ranges use
the declared bundle extent, so appended carrier bytes neither replace an
end-positioned directory nor become members.

## Resource bounds

These are resource policies, not format maxima.

| Resource                                        | Bound                                                                                  |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| Encoded and decoded directory buffers           | 16 MiB each                                                                            |
| Buffers, parsed rows, entries, path projections | 64 MiB shared admission, reserved before allocation                                    |
| One LZ4 or LZMA decode                          | 64 MiB output and LZMA window, plus its bounded encoded input; plain blocks stream     |
| Active member streams per reader                | 4                                                                                      |
| Archive plaintext work                          | Larger of 256 MiB and 500 × declared bundle size                                       |
| Member I/O operations                           | 4 × the larger of 1,024 and nonempty blocks + directory nodes + readable 64 KiB chunks |

Declared stream bytes, readable logical occurrences (including aliases) and
cumulative block-decode attempts are each charged against the plaintext-work
ceiling. The member-I/O budget admits ordinary passes while bounding repeated
tiny-block reads independently of output bytes. Empty-output blocks retain their
source count and offsets but are removed from member read plans. Unavailable
content is retained as named occurrences with unknown coverage and no invented
content hash.

Use summary delivery and retained inventory views for selected fields, filters
and paging; full Evidence remains available.

## CLI

```sh
rea inspect-artifact assets/hotfix.bundle --detail summary \
  --evidence_output evidence/hotfix.json --json
rea extract-artifact assets/hotfix.bundle --json
```

Detection is byte-based on the `UnityFS\0` signature, so `.bundle`, `.ab`,
`assets_*` YooAsset bundles and extensionless files all classify as `unityfs`
containers.

## Verification scope

Synthetic fixtures cover format 6–8 layouts, padding independent of header
alignment, directories, malformed tables, allocation admission, overlapping
members, LZMA blocks and malformed LZMA, cancellation inside decoding, paused iteration,
close during I/O, cleanup retry, empty blocks with unsupported codecs, cache
freshness and independent output buffers. Compiled CLI and full/compact MCP
tests cover inventory and extraction.

Public bundles from the UnityPy corpus, pinned to commit
`417d59522a998fdee9a9c2b29fe35f3063222457`, are checked against independent
UnityPy 1.24.2 raw member bytes:

| Bundle             | Unity version         | Result                                                                                     |
| ------------------ | --------------------- | ------------------------------------------------------------------------------------------ |
| `atlas_test`       | 2018.4.11f1, format 6 | Members match (SHA-256 `61ee5afb5f5c64f0a4f65f039d09b2509198363e713423289c895067ac215177`) |
| `banner_1`         | 2018.4.4f1            | Members match                                                                              |
| `char_118_yuki.ab` | 5.6.7f1               | Members match                                                                              |
| `xinzexi_2_n_tex`  | 2017.4.37f1, LZMA     | Unverified for this change (sample not rerun); synthetic LZMA round-trips only             |

UnityPy-produced repacks additionally verify format 7/8, padded and unpadded
front tables, end tables, and LZMA directories. They are library-produced, not
Unity engine executions, and synthetic fixtures alone do not establish real
Unity version coverage. SerializedFile objects, textures and runtime behavior
are outside this reader's verification scope.
