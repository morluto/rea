# Release exposure verification 2026-10-31

Ran `node scripts/verify-release-exposure.mjs` with Node v24.22.1. The package script is `npm run verify:release-exposure`, which runs `npm run build:cached` first because `scripts/rea.mjs` loads the compiled CLI. `@electron/fuses` 2.1.3 was installed into a temporary prefix and `flipFuses` was called on the after framework binary.

The fixture is `MyApp.app`. `Contents/Resources/app.asar` holds `app.js`. Before, it also holds `app.js.map` with `sourcesContent`. `Contents/Frameworks/Electron Framework.framework/Electron Framework` is an ELF larger than 256 KiB with the Electron fuse sentinel and a version-1 fuse wire. After, the archive is rebuilt without the map and `flipFuses` disables `RunAsNode` and `EnableNodeCliInspectArguments` and enables `OnlyLoadAppFromAsar` and `EnableEmbeddedAsarIntegrityValidation`. `app.js` remains, so `packaging.extractable_payload` stays exposed. Embedded ASAR integrity stays `unknown` on ELF. Go and Rust stay `unknown` because the framework binary is registered and has no build metadata; that is not `not_applicable`.

`--fail_on high` on the before app exited 3.

## Before

| Check                           | Status           | Severity |
| ------------------------------- | ---------------- | -------- |
| `javascript.source_map_sources` | `exposed`        | `high`   |
| `javascript.source_maps`        | `not_observed`   | `null`   |
| `electron.run_as_node`          | `exposed`        | `high`   |
| `electron.asar_integrity`       | `unknown`        | `null`   |
| `electron.only_load_from_asar`  | `exposed`        | `medium` |
| `electron.node_cli_inspect`     | `exposed`        | `medium` |
| `packaging.extractable_payload` | `exposed`        | `low`    |
| `native.debug_companions`       | `not_observed`   | `null`   |
| `native.pdb_path`               | `not_applicable` | `null`   |
| `go.build_paths`                | `unknown`        | `null`   |
| `rust.dependency_metadata`      | `unknown`        | `null`   |
| `text.credential_markers`       | `not_observed`   | `null`   |
| `native.hardening`              | `not_assessed`   | `null`   |
| `macho.hardened_runtime`        | `not_assessed`   | `null`   |
| `android.manifest`              | `not_assessed`   | `null`   |

## After

| Check                           | Status           | Severity |
| ------------------------------- | ---------------- | -------- |
| `javascript.source_map_sources` | `not_observed`   | `null`   |
| `javascript.source_maps`        | `not_observed`   | `null`   |
| `electron.run_as_node`          | `not_observed`   | `null`   |
| `electron.asar_integrity`       | `unknown`        | `null`   |
| `electron.only_load_from_asar`  | `not_observed`   | `null`   |
| `electron.node_cli_inspect`     | `not_observed`   | `null`   |
| `packaging.extractable_payload` | `exposed`        | `low`    |
| `native.debug_companions`       | `not_observed`   | `null`   |
| `native.pdb_path`               | `not_applicable` | `null`   |
| `go.build_paths`                | `unknown`        | `null`   |
| `rust.dependency_metadata`      | `unknown`        | `null`   |
| `text.credential_markers`       | `not_observed`   | `null`   |
| `native.hardening`              | `not_assessed`   | `null`   |
| `macho.hardened_runtime`        | `not_assessed`   | `null`   |
| `android.manifest`              | `not_assessed`   | `null`   |

`javascript.source_map_sources`, `electron.run_as_node`, `electron.node_cli_inspect`, and `electron.only_load_from_asar` changed from `exposed` to `not_observed`. `electron.asar_integrity` stayed `unknown`. `packaging.extractable_payload` stayed `exposed`.
