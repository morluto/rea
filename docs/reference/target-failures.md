# Target failures

When REA cannot read a target, `details.failure_kind` identifies why. It is the primary machine identifier, in the sense of an RFC 9457 problem type. `code` is a coarse class derived from it, and `retry` says whether repeating the request can help. Clients should branch on `failure_kind` and must not parse `message`, `remediation.action` or `details.reason`.

## Kinds

| `failure_kind` | Meaning                                                                          | `code`                      | `category`           | `retry`                               | What to do                                                                                                    |
| -------------- | -------------------------------------------------------------------------------- | --------------------------- | -------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `selection`    | The request names something that is not a valid target for this operation.       | `invalid_request`           | `invalid_input`      | `after_change`                        | Fix the request.                                                                                              |
| `unrecognized` | No reader for this operation recognizes the bytes.                               | `unsupported_target`        | `unsupported_target` | `none`                                | Choose another operation or provider.                                                                         |
| `unsupported`  | A recognized format, but in a version or variant this reader does not implement. | `unsupported_target`        | `unsupported_target` | `none`                                | Choose another operation or provider.                                                                         |
| `malformed`    | The bytes break the format's own rules.                                          | `unsupported_target`        | `unsupported_target` | `none`                                | Choose another target, or a well-formed copy.                                                                 |
| `truncated`    | The bytes end before a structure they declare.                                   | `unsupported_target`        | `unsupported_target` | `none`                                | Re-acquire the complete file.                                                                                 |
| `integrity`    | The bytes contradict a digest or checksum they declare.                          | `target_integrity_mismatch` | `integrity_mismatch` | `none`                                | Get a fresh copy, or keep the observed bytes with `integrity_policy=record-and-continue` where it is offered. |
| `conflict`     | Two or more inputs each parse, but disagree. None is blamed.                     | `input_conflict`            | `invalid_input`      | `after_change`                        | Select inputs that belong together.                                                                           |
| `changed`      | The file changed while it was read.                                              | `artifact_changed`          | `integrity_mismatch` | `backoff`                             | Retry once it is stable.                                                                                      |
| `access`       | Host permissions denied the read.                                                | `access_denied`             | `unavailable`        | `after_change`                        | Grant read access.                                                                                            |
| `io`           | The host could not read the file.                                                | `host_io_failed`            | `execution_failure`  | `backoff` (transient errno) or `none` | Retry with backoff for a transient error. Otherwise check the device and file.                                |

The four target refusals share `unsupported_target` because the caller cannot use the target as it stands, and each needs a different target or tool. `failure_kind` says which. No other code covers more than one kind.

The list of kinds can grow. Handle the kinds you know, and treat any other kind by its `code`.

Inventory operations report a container, member or read range that changed during the read as `changed`, with `details.integrity_check` naming the check (`container-identity`, `member-identity`, `unpacked-entry-identity`, `read-coverage` or `traversal-coverage`). A selected target that no longer matches the one the session opened (`integrity_check: admitted-identity`) is not `changed`: reopen the target instead of repeating the request.

A caller's cancellation (`cancelled`) and an admission limit (`resource_constraint`) describe the operation, not the target, so they keep their own error shapes. A result cut short by a delivery or decode limit reports code `partial`. `truncated` names only a target whose bytes end early.

## Retry

| `retry`        | Meaning                                                           |
| -------------- | ----------------------------------------------------------------- |
| `none`         | Repeating the request cannot help. The target itself must change. |
| `backoff`      | The unchanged request may succeed later. Retry with backoff.      |
| `after_change` | Only a changed request, input or host permission can succeed.     |

`retryable` keeps the meaning it has across all REA errors: the unchanged request may succeed. For a target failure, it is `true` exactly when `retry` is `backoff`.

## Details

Every target failure reports:

- `operation`: the operation that refused the target.
- `path`: the exact file at fault. For a composite request, this is the input whose bytes failed. For a conflict, it is the primary input, and `inputs` lists all of them.
- `failure_kind`: the kind.
- `format`: the format whose owner established the failure, such as `elf`, `macho` or `pe-cli`.
- `reason`: the owner's description, for people.
- `offset` and `field`: where the failure is, when the owner knows.
- `partial_observation`: the file's size and SHA-256, when the operation hashed the file before it refused it.

Some kinds add facts:

- `truncated` reports `available_bytes` and `required_bytes` when the owner measured them.
- `conflict` reports `inputs`, a list of `{ field, path }` entries, one for each input that disagrees. The CLI spells each `field` the way the command spells its option.

## MCP delivery

A target failure is always a `tools/call` result with `isError: true`, and its projection is the JSON text block. It is never a JSON-RPC error. A provider that throws a target failure inside a tool handler still produces this result.

## Migration

This model replaces `details.format_failure` with `failure_kind`. It also changes these codes:

- the `truncated` code to `partial`;
- `artifact_operation_failed` to `target_integrity_mismatch` or `host_io_failed`;
- `invalid_request` to `input_conflict`, for a pair of inputs that disagree.

The remaining operations move to this vocabulary area by area, and each release note lists the operations whose `code` changes. The plan is tracked in [#14239](https://github.com/morluto/rea/issues/14239).

Container and inventory readers (ZIP, ASAR, PyInstaller, .NET bundles, Node SEA, Deno and Bun standalones, Godot PCK, UnityFS, wxapkg, FIT, uImage, iNES, Android OTA payloads, ESP images, NTFS `$MFT` streams, firmware record files and others) now report damaged bytes as `malformed` or `truncated`, with the reader's `format`. Before, they reported `artifact_operation_failed` with `details.reason: "format"`. Two other things changed:

- The Playwright trace, NTFS journal, release exposure and web capture operations report a damaged selected file as `unsupported_target`, not `invalid_request`.
- A short read after REA measured the file is now an integrity failure with `details.integrity_check: "read-coverage"` (the file changed during the read), not a format error.

Related: [settings, limits and recovery](limits-and-recovery.md) for limit failures, and `docs/user-visible-errors.csv` for every error case and its code.
