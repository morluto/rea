# Target failures

When REA cannot read a target, the error reports why in one field: `details.failure_kind`. The kind decides `code`, `category`, `retryable` and the recovery. Clients should branch on `code` and `failure_kind`, and must not parse `message`, `remediation.action` or `details.reason`.

## Kinds

| `failure_kind` | Meaning                                                                          | `code`                        | `category`            | `retryable` | What to do                                                                                                    |
| -------------- | -------------------------------------------------------------------------------- | ----------------------------- | --------------------- | ----------- | ------------------------------------------------------------------------------------------------------------- |
| `selection`    | The request names something that is not a valid target for this operation.       | `invalid_request`             | `invalid_input`       | no          | Fix the request.                                                                                              |
| `unrecognised` | No reader for this operation recognises the bytes.                               | `unsupported_target`          | `unsupported_target`  | no          | Choose another operation or provider.                                                                         |
| `unsupported`  | A recognised format, but in a version or variant this reader does not implement. | `unsupported_target`          | `unsupported_target`  | no          | Choose another operation or provider.                                                                         |
| `malformed`    | The bytes break the format's own rules.                                          | `unsupported_target`          | `unsupported_target`  | no          | Choose another target, or a well-formed copy.                                                                 |
| `truncated`    | The bytes end before a structure they declare.                                   | `unsupported_target`          | `unsupported_target`  | no          | Re-acquire the complete file.                                                                                 |
| `integrity`    | The bytes contradict a digest or checksum they declare.                          | `artifact_integrity_mismatch` | `integrity_mismatch`  | no          | Get a fresh copy, or keep the observed bytes with `integrity_policy=record-and-continue` where it is offered. |
| `conflict`     | Two or more inputs each parse, but disagree. None is blamed.                     | `invalid_request`             | `invalid_input`       | no          | Check that the inputs belong together.                                                                        |
| `changed`      | The file changed while it was read.                                              | `artifact_changed`            | `integrity_mismatch`  | yes         | Retry once it is stable.                                                                                      |
| `access`       | Host permissions denied the read.                                                | `access_denied`               | `unavailable`         | no          | Grant read access.                                                                                            |
| `io`           | The host could not read the file.                                                | `artifact_operation_failed`   | `execution_failure`   | no          | Check the device and file.                                                                                    |
| `cancelled`    | The caller cancelled the operation.                                              | `cancelled`                   | `cancelled`           | yes         | Nothing.                                                                                                      |
| `resource`     | A named admission limit stopped the work.                                        | `resource_constraint`         | `resource_constraint` | no          | Raise the named control.                                                                                      |

The list of kinds can grow. Handle the kinds you know, and treat any other kind by its `code`.

`malformed`, `truncated`, `unrecognised` and `unsupported` share the `unsupported_target` code because the caller cannot use the target as it stands. `failure_kind` says which action helps. The `truncated` code keeps a single meaning: a result cut short by a limit. It is never used for a truncated target.

## Details

Every target failure reports:

- `operation`: the operation that refused the target.
- `path`: the exact file at fault. For a composite request, this is the input whose bytes failed.
- `failure_kind`: the kind.
- `format`: the format whose owner established the failure, such as `elf`, `macho` or `pe-cli`.
- `reason`: the owner's description, for people.
- `offset` and `field`: where the failure is, when the owner knows.
- `partial_observation`: the file's size and SHA-256, when the operation hashed the file before it refused it.

Some kinds add facts:

- `malformed` and `truncated` also report `format_failure` (the same value as `failure_kind`), which earlier releases reported.
- `truncated` reports `available_bytes` and `required_bytes` when the owner measured them.
- `conflict` reports `inputs`, a list of `{ field, path }` entries, one for each input that disagrees.

## Migration

Releases before this model reported a selected file's malformed or truncated bytes with the same `code` and `format_failure`. That is unchanged, and `failure_kind` is added. The remaining operations move to this vocabulary area by area, and each release note lists the operations whose `code` changes. The plan is tracked in [#14239](https://github.com/morluto/rea/issues/14239).

Container and inventory readers (ZIP, ASAR, PyInstaller, .NET bundles, Node SEA, Deno and Bun standalones, Godot PCK, UnityFS, wxapkg, FIT, uImage, iNES, Android OTA payloads, ESP images, NTFS `$MFT` streams, firmware record files and others) now report damaged bytes as `malformed` or `truncated`, with the reader's `format`. Before, they reported `artifact_operation_failed` with `details.reason: "format"`. They also changed in three other ways:

- `inventory_artifact`, `inspect_artifact`, `extract_artifact` and the other inventory operations report a truncated container as `unsupported_target`, not `truncated`.
- The Playwright trace, NTFS journal, release exposure and web capture operations report a damaged selected file as `unsupported_target`, not `invalid_request`.
- `inspect_sqlite_database`, `inspect_binary_layout`, `inspect_recorded_crash` and `inspect_evm_interface` also report a damaged selected file as `unsupported_target` (`failure_kind: "malformed"`, with `format` `sqlite`, `elf`, `elf-core` or `evm-bytecode`), not `invalid_request`.
- A short read after REA measured the file is now an integrity failure with `details.integrity_check: "read-coverage"` (the file changed during the read), not a format error.

Related: [settings, limits and recovery](limits-and-recovery.md) for `resource` failures, and `docs/user-visible-errors.csv` for every error case and its code.
