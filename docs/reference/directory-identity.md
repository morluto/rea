# Directory identity

`inspect_artifact` and `compare_artifacts` accept a directory path, such as a
build output folder or an installed application, without `open_binary`. REA
inventories the tree in place and names the directory by a content-addressed
root digest. Nothing in the tree is executed, extracted or modified.

- MCP: `inspect_artifact` with `path`, and `compare_artifacts` with
  `{"kind":"path","path":"/absolute/dir"}` on either side.
- CLI: `rea inspect-artifact <dir>` and
  `rea compare-artifacts '{"left":{"kind":"path","path":"a"},"right":{"kind":"path","path":"b"}}'`.

`open_binary` still refuses an ordinary directory with
`directory_requires_file`; native analysis needs a file or a supported Apple
bundle.

## The subject

A file subject keeps its SHA-256. A directory subject is:

```json
{
  "identity": {
    "kind": "directory",
    "algorithm": "rea-directory-tree",
    "version": 1,
    "sha256": "<root digest>"
  },
  "name": "build",
  "local_path": "/work/build"
}
```

The same tree, with the same stored names, gives the same identity on every
host and at every location.
Any change to a member's content, name or kind, or an added or removed member,
gives a new one. The identity does not depend on modification times,
ownership, permission bits or the order the host lists entries in.

The inventory result carries the same fact as `root_digest`, with
`member_count`, and the root node's `sha256` is the root digest.

## Partial walks

Hashing reads every member, so it is bounded by the existing inventory limits
and coverage. When a limit stops the walk, or a member cannot be read (a
directory or file the host denies, a name that is not valid UTF-8, a symlink
whose target cannot be read), `root_digest` is:

```json
{
  "algorithm": "rea-directory-tree",
  "version": 1,
  "status": "partial",
  "limitations": ["..."]
}
```

A partial walk has no digest, and its Evidence subject is
`{"kind":"unknown","reason":"not-observed"}`. A digest of only the members a
walk reached is never presented as the directory's identity.

## Encoding, version 1

The root digest is SHA-256 over one canonical byte string:

```text
"rea-directory-tree" NUL  u32be(1)  u64be(record count)  record*
record   = u8(kind)  field(path)  kind-specific fields
field(b) = u64be(byte length of b)  b
```

| Member           | Kind byte | Fields after the path                    |
| ---------------- | --------- | ---------------------------------------- |
| Regular file     | `0x01`    | 32 raw bytes of the content SHA-256      |
| Directory        | `0x02`    | none                                     |
| Symlink          | `0x03`    | `field(target bytes)`, exactly as stored |
| FIFO             | `0x04`    | none                                     |
| Socket           | `0x05`    | none                                     |
| Block device     | `0x06`    | none                                     |
| Character device | `0x07`    | none                                     |

- `path` is relative to the root and joins each name's exact stored bytes
  with `/`. Names are never Unicode-normalized: on a file system that stores
  both a composed and a decomposed `é`, they are two members with two
  records. REA reads only names that decode as strict UTF-8, which re-encode
  to the same bytes; any other name makes the walk partial. The root has no
  record.
- Records are sorted by the bytes of `path`. For UTF-8 this is Unicode code
  point order.
- Every directory has a record, so an empty subdirectory is part of the
  identity. The empty root directory is the header with a count of zero:
  `b28a57a57239d69019456fc9079821c5f31911fc656d15ff77703cb13991b3b6`.
- Symlinks are recorded, not followed, so a link that points outside the tree
  does not bring the outside content into the identity.
- FIFOs, sockets and devices are recorded by kind and are never opened.

## Why this encoding

The design follows tools that already content-address trees:

- [Git tree objects](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)
  hash a sorted list of `mode name NUL digest` entries. Git keeps the
  executable bit and drops empty directories; REA keeps empty directories and
  drops the executable bit, which some hosts cannot observe. The executable
  marking still appears on each occurrence and in comparisons.
- The [Nix archive format](https://nix.dev/manual/nix/stable/protocols/nix-archive/)
  serializes entries sorted by name with length-prefixed strings and records
  regular files, directories and symlink targets, which makes its encoding
  injective.
- Go's [`dirhash.Hash1`](https://pkg.go.dev/golang.org/x/mod/sumdb/dirhash)
  hashes a sorted, line-oriented summary of per-file digests. Its text format
  has to refuse names containing a newline; length-prefixed fields need no
  such refusal.
- [Dirhash](https://github.com/andhus/dirhash) shows that separators and the
  set of recorded entry properties must be part of a named, versioned protocol.
- [OCI descriptors](https://github.com/opencontainers/image-spec/blob/main/descriptor.md#digests)
  name the algorithm with the digest, and OCI layer digests show that hashing
  an archive makes the identity depend on archive ordering and metadata.
- [RFC 6962](https://www.rfc-editor.org/rfc/rfc6962#section-2.1) separates
  hash domains with a prefix. The header and kind bytes do the same here.
- [UAX #15](https://unicode.org/reports/tr15/) normalization forms are not
  applied. Normalizing would give two distinct names one path, so trees that
  differ only by swapping those members' contents would share an identity.
  Inventory occurrences keep their NFC logical paths for display and
  comparison; the identity uses the bytes the file system stored, so a tree
  copied between file systems that normalize names differently can get a
  different identity.

The encoding is flat: one hash over every record, rather than a hash per
subdirectory as Git does. REA's inventory is already a flat list of
occurrences, and no workflow reuses subtree digests yet. A later version that
adds subtree digests would get a new `version`.
