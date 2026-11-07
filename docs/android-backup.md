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
zlib-compressed TAR. Regular files, directories, USTAR prefixes and local PAX
headers are supported. PAX path, size, owner and timestamp fields are retained;
unsupported entry types or PAX attributes produce an explicit refusal.

The archive's SHA-256 identifies the original acquisition. Each member retains
its original path, content hash and TAR header/data offsets. For compressed
backups those offsets address the decoded TAR stream, and `source_location`
is null: they are not physical positions in the compressed carrier. Plain
backups also retain physical member ranges. Header checksums validate TAR
headers, not the authenticity of the archived file contents. Stored modes
are observations; extraction does not restore owners or apply archived modes.

An `AES-256` header is identified as encrypted, with unknown member coverage.
Its encryption-specific header is not parsed, so `payload_offset` is null;
the end of the encryption-method line does not establish the payload start.
Inspection retains the envelope facts; extraction refuses rather than creating
an empty output. Unsupported versions, encryption methods, malformed numeric
fields, header checksums, truncated data, invalid UTF-8, duplicate paths and
file/directory conflicts are reported explicitly. Links, sparse entries,
global PAX headers and GNU long-name extensions are unsupported.

## Bounds and verification

This in-memory importer limits both the encoded payload and expanded TAR to
64 MiB. It admits at most 8 MiB of conservatively estimated directory metadata
and four simultaneous member streams. Oversized input and expansion are
resource refusals; lowering extraction selection does not bypass validation of
the full archive. Extraction reuses the existing destination ownership,
path-safety, durable-readback and cleanup rules.

Tests use authored archives and public CLI/MCP workflows, including compressed
and plain data, selected extraction, original-file preservation, encrypted
coverage, malformed input, path conflicts and decompression expansion. These
fixtures do not establish compatibility with every device/vendor backup.

The envelope follows [AOSP's backup reader](https://android.googlesource.com/platform/frameworks/base/+/3abc7511b881e3fcc3de8c8c87093bd661bd0f91/services/backup/java/com/android/server/backup/restore/PerformAdbRestoreTask.java).
