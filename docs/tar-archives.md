# tar and gzip-compressed tar archives

`inspect-artifact` and `extract-artifact` read POSIX tar archives, stored or
wrapped in gzip, without running `tar` or any other tool. This covers Linux
release tarballs (`.tar`, `.tar.gz`, `.tgz`) and Unity `.unitypackage` files,
which are gzip-compressed tar archives of `<guid>/asset`, `<guid>/asset.meta`
and `<guid>/pathname` members.

Detection uses the bytes, not the file name. A file is `tar` when its first
512-byte block is a ustar or GNU header with a valid checksum, or when it is
a gzip member (RFC 1952) whose first decompressed block is one. A first block
that carries the ustar magic but fails its checksum is refused with that
reason. A gzip stream that does not hold tar is not claimed.

## What inventory reports

Each regular file, directory and symbolic link is an occurrence. Names come
from, in order: a pax `path` record, a GNU `L` long-name record, or the ustar
`prefix` and `name` fields. A leading `./` is dropped from the logical path
and kept in `source_path`. A pax `path`, `linkpath`, `uname` or `gname`
value that is not UTF-8 is read only under `hdrcharset=BINARY`, as Latin-1
with a limitation giving its raw bytes. Member contents are hashed and
classified like ZIP members, so an ELF, Godot PCK or UnityFS member inside a
tarball is named by its format.

Directory, symbolic link, device and FIFO headers store no data blocks, as
POSIX ustar specifies, even when their size field is nonzero. The next header
is read directly after them. A hard link keeps its declared size, because a
pax archive may store a body for it.

The root occurrence's `format_metadata` (`kind: "tar"`) records:

- `compression`: `none` or `gzip`.
- `dialects`: the header magics seen (`ustar`, `gnu`).
- `pax_headers` and `member_count`.
- `tar_stream_bytes`: tar bytes examined, which is the decompressed size for gzip.
- `end_state` and `end_offset`: where the walk stopped. `end-marker` means a zero block. `eof` means the stream ended at a header boundary without one. `malformed` and `truncated` are described below.
- `trailing_nonzero_bytes`: non-zero bytes after the end marker.

Each member's `format_metadata` (`kind: "tar-entry"`) records its header and
data offsets in the tar stream, typeflag, permission bits, uid, gid, user and
group names, mtime and link target. `compare-artifacts` compares the
typeflag, mode and link target. Owners and times vary between otherwise
equal builds, so it does not compare them. For stored tar,
`source_location` is the member's byte range in the file. For gzip, offsets
are positions in the decompressed stream, so `source_location` is null.

Coverage is `complete` only when the walk reached the end-of-archive marker
and only zero bytes follow it.

## Partial, malformed and truncated archives

A first header that is invalid refuses the archive as malformed tar. After
that, the reader keeps what it has read and reports `unknown` coverage
instead of refusing:

- A later header that fails its checksum, has no ustar magic, or holds a malformed pax record sets `end_state: "malformed"` at that header's offset.
- A member whose data runs past the end of the stream is not listed. A header cut off by the end of the stream, or a gzip stream that ends early, sets `end_state: "truncated"`.
- Corrupt deflate data or a gzip CRC mismatch sets `end_state: "malformed"`. Members whose bytes were fully decompressed before that point are kept.
- Non-zero bytes after the end marker are counted and named in a limitation.

## Members that are not read

Hard links, character and block devices, FIFOs, GNU sparse members (typeflag
`S` or pax `GNU.sparse.*`) and vendor typeflags are reported as traversal
omissions, which make coverage `unknown`. A GNU volume label and the
archive's own `./` root carry no occurrence. Pre-POSIX (v7) headers without
the ustar magic are unsupported.

Unsafe member paths are handled as they are for ZIP. An absolute path, a
`..` component or a NUL refuses inventory with a path error, and
extraction never writes outside its fresh output root.

## Resource bounds

- Gzip decompression, including the preparation pass, is charged to the archive plaintext-work allowance `artifact_limits.expanded_bytes`. Its default is the larger of 256 MiB and 500 times the file size.
- Members opened in archive order share one forward decompression. A member opened out of order starts a new decompression, which is charged again.
- `artifact_limits.tar.extended_header_bytes` (default 1 MiB) bounds one pax or GNU long-name record.
- `artifact_limits.tar.metadata_bytes` (default 64 MiB) bounds retained member metadata: a fixed 512 bytes per member plus its path and link bytes. A refusal reports either field in `details.reader_limit`.
- A reader serves at most four member streams at once.

## CLI

```sh
rea inspect-artifact Pixelorama-Linux-64bit.tar.gz --detail summary \
  --evidence_output evidence/release.json --json
rea extract-artifact UniVRM-0.131.4_efd2.unitypackage --json
```

Use `inspect_analysis_view` with the retained Evidence ID to page members
without reading the whole inventory inline.

## Verification scope

Synthetic fixtures, built in the tests from the POSIX ustar layout, cover
stored and gzip archives, pax paths, GNU long names, ustar prefixes,
symbolic links, omitted devices, FIFOs and hard links, header-only members
that declare a size, a corrupt later header, trailing data, a truncated
member, a cut gzip stream, a corrupt first header and the expansion
allowance. Public release files checked: the
Pixelorama v1.2.4 Linux tarball (39 members, including an ELF executable and
a Godot PCK) and the UniVRM 0.131.4 `.unitypackage` (3,091 members). Both
reported complete coverage. xz, bzip2 and zstd wrappers are not read. The
`.unitypackage` `pathname` mapping is not projected.
