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

Inventory operations report a container, member or read range that changed during the read as `changed`, with `details.integrity_check` naming the check (`container-identity`, `member-identity`, `unpacked-entry-identity`, `read-coverage` or `traversal-coverage`). Every operation that reads a selected artifact follows the same rule. A selected target that no longer matches the one the session opened (`integrity_check: admitted-identity`) is not `changed`: it reports `artifact_operation_failed` with `retryable: false`, and you reopen the target instead of repeating the request. Any other failed integrity check is likewise not retryable unchanged.

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
- `inspect_sqlite_database`, `inspect_binary_layout`, `inspect_recorded_crash` and `inspect_evm_interface` also report a damaged selected file as `unsupported_target` (`failure_kind: "malformed"`, with `format` `sqlite`, `elf`, `elf-core` or `evm-bytecode`), not `invalid_request`.
- A short read after REA measured the file is now an integrity failure with `details.integrity_check: "read-coverage"` (the file changed during the read), not a format error.
- An inventory, inspection or extraction of a container (`inventory_artifact`, `inspect_artifact`, `extract_artifact` and the bundle readers such as `inspect_keyed_archive`) reports damaged or unsupported bytes as a target failure of the selected `path`, with top-level `retry`, like every other operation. `details.reason` is now the owner's description, and `details.detail` is gone. Before, these refusals reported `details.reason: "malformed"`, `"truncated"` or `"unsupported"` with the description in `details.detail`, and no `path`.
- A file that is not a native image at all is now `unrecognized`, not `malformed` or `unsupported`. `inspect_native_initializers` reports a file with neither ELF nor Mach-O magic, such as a PE file, as `unrecognized` (`format: "native-binary"`). Thin Mach-O readers, such as `inspect_macho_function_starts`, report bytes without Mach-O magic as `unrecognized` (`format: "macho"`). The Go and Rust binary readers report bytes that are not ELF, PE or Mach-O as `unrecognized` too. A recognized header that is cut off or broken stays `truncated` or `malformed`.
- Every unsupported or unrecognized target is now a target failure too: `failure_kind` is `unsupported` or `unrecognized`, with the owner's `format`, top-level `retry`, and a recovery from the table. Where the owner knows which operations read the target, the recovery names them and `details.related_operations` lists them. Producer-written remediation sentences are gone; their guidance is in `details.reason`.

Related: [settings, limits and recovery](limits-and-recovery.md) for limit failures, and `docs/user-visible-errors.csv` for every error case and its code.
