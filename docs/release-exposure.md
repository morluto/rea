# Release exposure

`audit_release_exposure` / `audit-release-exposure` reads one shipped artifact and reports what static analysis of that artifact recovers. The input is a macOS `.app` bundle, an install directory, an ASAR, or a single executable. Each check has a stable id, a status, the observation behind that status, and fixed remediation text.

The report does not establish that an application is secure. A check that could not be completed is `unknown` or `not_assessed`, and those counts stay beside the findings. There is no pass verdict and no letter grade.

```bash
rea audit-release-exposure /Applications/Example.app --json
rea audit-release-exposure ./dist/MyApp.app --fail_on high --json
```

Without `--fail_on`, the exit status reflects only whether the audit finished. With `--fail_on high`, `--fail_on medium`, or `--fail_on low`, a completed audit exits `3` when an `exposed` check meets that severity. `high` matches high. `medium` matches high and medium. `low` matches high, medium, and low. `unknown` and `not_assessed` do not change the exit status. A tool failure is still exit `1`.

The CLI resolves a relative path against the caller's working directory. MCP requires an absolute filesystem path and returns the same report. MCP has no exit status.

```json
{
  "name": "audit_release_exposure",
  "arguments": { "path": "/Applications/Example.app" }
}
```

## What is read

The audit composes existing readers. It does not reread Electron fuse bytes itself, and it does not rewrite the artifact.

| Check                           | Exposed when                                                             | Severity |
| ------------------------------- | ------------------------------------------------------------------------ | -------- |
| `javascript.source_map_sources` | A shipped source map has `sourcesContent`                                | high     |
| `javascript.source_maps`        | A shipped source map has no embedded sources                             | medium   |
| `electron.run_as_node`          | The fuse implication is honored                                          | high     |
| `electron.asar_integrity`       | Embedded ASAR integrity is not enforced                                  | medium   |
| `electron.only_load_from_asar`  | Loading is not restricted to `app.asar`                                  | medium   |
| `electron.node_cli_inspect`     | Node CLI inspect arguments are honored                                   | medium   |
| `packaging.extractable_payload` | A Bun, Node SEA, PyInstaller, .NET bundle, or ASAR has a readable member | low      |
| `native.debug_companions`       | A `.pdb`, `.dSYM`, `.debug`, or linker `.map` ships beside the release   | medium   |
| `native.pdb_path`               | A PE CodeView record names a PDB path                                    | low      |
| `go.build_paths`                | Go build info or its build flags contain file paths                      | low      |
| `rust.dependency_metadata`      | cargo-auditable metadata is present                                      | low      |
| `text.credential_markers`       | A text member contains a provider-prefixed marker                        | high     |
| `native.hardening`              | Not assessed in this audit                                               |          |
| `macho.hardened_runtime`        | Not assessed in this audit                                               |          |
| `android.manifest`              | Not assessed in this audit                                               |          |

`text.credential_markers` matches provider-prefixed forms such as a PEM private-key header and documented vendor token prefixes. The report contains the rule id and location only. Matched bytes, previews, lengths, and hashes of matched bytes are omitted.

`native.hardening`, `macho.hardened_runtime`, and `android.manifest` stay `not_assessed`. Their next probes are `inspect_binary_hardening`, `inspect_signature`, and `inspect_android_package`.

Source map text is counted and then dropped. A selected file is read through the stable artifact reader. Text and source-map members stay inside the allowances listed under `coverage.allowances`, and each kind has its own allowance, so binary members cannot use up the read that a later source map needs. Native images on disk are registered from inventory classification and are not limited to those allowances. Other files and package members are identified from a bounded header. A header with no NUL byte is scanned as text, so names such as `.env.production`, `server.key`, and `credentials` do not depend on an extension list. UTF-16 text has NUL bytes and is not recognized this way. A file whose header could not be read leaves `text.credential_markers` undecided. Among binary package members, only a PE is read further, for its debug records. Skipped members are listed under `coverage.omitted`. When the selection is a file, the parent directory is listed up to a fixed entry allowance for sibling `.pdb`, `.dSYM`, `.debug`, and linker `.map` debug companions.

Inventory stops at 65,536 entries or 2 GiB of hashed bytes, and member coverage then stays `unknown`. A declared integrity value that disagrees with the bytes does not stop the audit, because signing an unpacked native module after packaging is routine. The contradiction is recorded in the limitations and the audit continues.

A member of a package that inventory did not expand is reported as the host file path followed by the member path, for example `/dist/app.dll/notes.txt`. Inventory-expanded members keep their path relative to the selection.

A package member skipped by a read allowance still counts as readable for `packaging.extractable_payload`, because the format stores it unencrypted. An encrypted member or one that failed to read counts as unreadable.

A `.map` too large to parse is a linker map when its header cannot begin a JSON object. A larger `.map` that begins as JSON, or that has a JavaScript name such as `app.js.map`, is counted as skipped. `native.debug_companions` identifies a companion from its name or from a `.map` body that is not a source map, so its `exposed` result has `inferred` confidence.

## Status

`exposed` means the check's condition was observed. `not_observed` means that condition was absent in a completed scan. `not_applicable` means the check does not apply to this artifact, for example Electron fuses on an app bundle with no Electron Framework, or on a directory whose native images were all read and hold no fuse sentinel. `unknown` means the check could not be decided, including a directory with no ASAR layout where those reads are missing or incomplete (an `asar: false` Electron build has no ASAR to find), safe fuses from an incomplete inventory that has not accounted for the Electron executable, a missing fuse sentinel on an Electron target, a universal binary with a slice that has no sentinel or an undecided fuse, a file that changed after inventory, Electron fuses on a selected ASAR (which does not include the executable that holds them), a PE inside a package that was too large to read, Go or Rust metadata on a native image stored inside a package, and Go or Rust metadata that was not present. Absence of that metadata is not proof the binary is something else. `not_assessed` means this audit did not run the check.

Cancellation during a Go, Rust, fuse, or desktop read returns a typed cancellation error. Its partial observation holds the report with completed facts, and checks whose readers did not run are `unknown`. Cancellation during the member scan itself returns no partial report.

Severity is `null` unless the status is `exposed`.
