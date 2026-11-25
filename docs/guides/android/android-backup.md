# Android ADB backup archives

`inspect-artifact` and `extract-artifact` read legacy Android `.ab` backups
offline. Recognition uses the `ANDROID BACKUP` signature, including for files
without an extension. Neither operation connects to ADB, restores a device,
executes app content, or attempts decryption.

```sh
rea inspect-artifact backup.ab --json
rea extract-artifact backup.ab --output-root /absolute/new-output --json
```

To extract selected files, pass their inventory `occurrence_id` values with
repeatable `--occurrence-id` options. MCP uses the same `inspect_artifact` and
`extract_artifact` workflows; `output_root` selects the destination and
`occurrence_ids` selects entries. The original archive is unchanged.

## Supported input and provenance

Versions 1 through 5 support unencrypted payloads, either plain TAR or
zlib-compressed TAR. The reader supports regular files and directories in
legacy v7 and USTAR TAR headers, with support for USTAR prefixes and local PAX
headers. Inspection retains PAX path, size, owner and timestamp fields. The
reader refuses unsupported entry types and PAX attributes.

The archive's SHA-256 identifies the original acquisition. Each member retains
its original path, content hash and TAR header/data offsets. For compressed
backups those offsets address the decoded TAR stream, and `source_location`
is null: they are not physical positions in the compressed carrier. Plain
backups also retain physical member ranges. Header checksums validate TAR
headers, not the authenticity of the archived file contents. Stored modes
are observations. Extraction writes member contents without restoring owners
or applying archived modes.

`compare_artifacts` compares a member's permission bits as format metadata.
It uses the resolved occurrence path and content identity for path and byte
comparison. Inspection retains the raw PAX records and TAR offsets for
provenance. Switching between a USTAR prefix and a PAX path does not change
the member comparison when the effective path, bytes and mode are the same.

An `AES-256` header is identified as encrypted, with unknown member coverage.
Its encryption-specific header is not parsed, so `payload_offset` is null;
the end of the encryption-method line does not establish the payload start.
Inspection retains the envelope facts; extraction refuses rather than creating
an empty output. Unsupported versions, encryption methods, malformed numeric
fields, header checksums, truncated data, invalid UTF-8, duplicate paths and
file/directory conflicts are reported explicitly. Links, sparse entries,
global PAX headers and GNU long-name extensions are unsupported.

## Bounds and verification

The importer defaults to 64 MiB each for the encoded payload and decoded TAR
and 8 MiB for the directory representation. Set `encoded_bytes`,
`expanded_bytes` or `directory_bytes` in `artifact_limits.android_backup`
to change those allowances for the next call. In the CLI, pass the same object
through `--artifact-limits`. The reader admits four simultaneous member streams.
Selecting fewer members still requires validation of the full archive.
Extraction reuses destination ownership, path safety, durable readback and
cleanup rules.

Tests use authored archives and public CLI/MCP workflows, including compressed
and plain data, selected extraction, original-file preservation, encrypted
coverage, malformed input, path conflicts and decompression expansion. These
fixtures do not establish compatibility with every device/vendor backup.

The envelope follows [AOSP's backup reader](https://android.googlesource.com/platform/frameworks/base/+/3abc7511b881e3fcc3de8c8c87093bd661bd0f91/services/backup/java/com/android/server/backup/restore/PerformAdbRestoreTask.java).
