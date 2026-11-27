# VS Code extension packages

`inspect_vsix_package` / `inspect-vsix-package` reads one selected local
`.vsix` as a ZIP and reports package identity from `extension.vsixmanifest`
and `extension/package.json`, activation events, a contributes summary, and a
contents inventory. It does not install the extension, execute anything in it,
or contact a marketplace.

```bash
rea inspect-vsix-package /absolute/path/to/demo.hello-1.2.3.vsix --json
```

With `--detail summary --evidence_output /absolute/path/vsix.json`, the CLI
saves the complete Evidence as a new bundle and prints a summary view with
identity, engine, target platform, entry points, signature presence, coverage,
and counts of activation events, commands, contents, interesting members and
limitations.

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_vsix_package",
  "arguments": { "path": "/artifacts/demo.hello-1.2.3.vsix" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte length.

`vsix_identity` reports `id`, `version`, `publisher`, `target_platform`,
`display_name`, and `description` as present in `extension.vsixmanifest`.
`package_identity` reports `name`, `publisher`, and `version` as present in
`extension/package.json`. Missing fields are `null`. When a unique
vsixmanifest or package.json cannot be selected, that identity is `null`.
`identity_disagreements` lists fields whose values differ between the two
manifests.

`engine` reports the `Microsoft.VisualStudio.Code.Engine` property and
`engines.vscode` range, with `disagreement` when both are present and differ.
`target_platform` is the vsixmanifest Identity `TargetPlatform`.
`entry_points.main` and `entry_points.browser` are the package.json paths
resolved under `extension/`, each with `present` true when that ZIP member
exists.

`activation_events` lists each package.json event with `eager` true for `*`
and `onStartupFinished`. `contributes` lists contribute key names and counts,
and a capped command list (`commands_total` and `commands_omitted` keep the
remainder). `extension_dependencies` and `extension_pack` keep both
manifests' declared ids and a `disagreement` flag. A side is `null` when its
manifest was missing or could not be read, and `disagreement` is only true
when both sides were read. `extension_kind`,
`capabilities.untrusted_workspaces` / `virtual_workspaces`, and
`enabled_api_proposals` come from package.json when present.
`assets` lists vsixmanifest Asset Type/Path pairs and whether each path is
present in the ZIP.

`signatures.p7s` and `signatures.manifest` are true when
`extension.signature.p7s` or `.signature.manifest` is present. Presence is
not verification.

`contents` lists file ZIP members with the stored ZIP `name`, a logical
`path` (backslashes as `/`, leading `./` removed), uncompressed and compressed
sizes, an `encrypted` flag, a path-derived `kind`, and `traverses`. Directory
markers are omitted. Encrypted members are listed and not extracted.
`interesting_members` lists native addons, wasm modules, executables, shell
scripts, and nested archives with byte length, SHA-256 when hashed, and
`classification` `observed` (magic bytes) or `inferred` (name or Unix
executable bit). Member kinds are ZIP-name and magic conventions, not a
runtime load inventory.

## Limits and failures

The selected file is limited to 64 MiB by default (512 MiB maximum). At most
4096 ZIP entries are inventoried by default (65536 maximum). Each of
`extension.vsixmanifest` and `extension/package.json` is limited to 1 MiB by
default (16 MiB maximum); exceeding that budget fails without partial success.
Interesting members are hashed up to 1 MiB by default (16 MiB maximum);
exceeding that budget lists the member without a digest. Invalid ZIP input
fails without a partial inventory.

Missing, malformed, path-traversal, or duplicate-name members succeed with
the ZIP inventory and explicit limitations. A vsixmanifest DOCTYPE is
unsupported. This workflow does not install extensions, verify signatures, or
execute bundled code. Package identity and contributes metadata are
publisher-provided and do not establish extension safety.

Evidence parameters retain only caller-selected controls; execution resolves omitted budgets from the documented defaults.
