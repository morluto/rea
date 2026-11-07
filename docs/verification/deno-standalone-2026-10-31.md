# Deno compile executable verification — 2026-10-31

The command was:

```sh
PATH="<deno-2.9.8-dir>:$PATH" npm run verify:deno:standalone
```

`npm run verify:deno:standalone` is `npm run build:cached && node scripts/verify-deno-standalone.mjs`. That Node binary prints `v24.22.1`. Deno was the unpacked `v2.9.8` `deno-aarch64-apple-darwin` release. The script refused any other Deno version before compiling. The produced executables were not run.

## Producer

`deno --version`, as captured in the script's JSON:

```text
deno 2.9.8 (stable, release, aarch64-apple-darwin)
v8 15.0.245.2-rusty
typescript 6.0.3
```

Host reported by the script: `darwin-arm64`. The host compile used `--env-file`, `--self-extracting`, and `--no-check`. Cross compiles used `deno compile --target` and `--no-check`.

## Script JSON

```json
{
  "deno": "deno 2.9.8 (stable, release, aarch64-apple-darwin)\nv8 15.0.245.2-rusty\ntypescript 6.0.3",
  "host": "darwin-arm64",
  "root_format": "deno-standalone",
  "carrier": "mach-o",
  "embedding": "mach-o-section",
  "entrypoint_key": "main.ts",
  "env_var": {
    "name": "REA_DENO_TOKEN",
    "value": "super-secret-value",
    "value_byte_length": 18
  },
  "env_value_retained_in_inspect_json": true,
  "npm_snapshot_byte_length": 0,
  "self_extracting_recorded": true,
  "main_logical_path": "main.ts",
  "asset_logical_path": "asset.txt",
  "long_module_logical_path": "deno-vfs/1",
  "long_module_source_bytes": 243,
  "damaged_native_elf_root_format": "elf",
  "extraction_verified": true,
  "target_executed": false,
  "crosses": [
    {
      "target": "x86_64-unknown-linux-gnu",
      "carrier": "elf",
      "embedding": "elf-note",
      "extracted": true
    },
    {
      "target": "x86_64-pc-windows-msvc",
      "carrier": "pe",
      "embedding": "pe-resource",
      "extracted": true
    },
    {
      "target": "x86_64-apple-darwin",
      "carrier": "mach-o",
      "embedding": "mach-o-intel-trailer",
      "extracted": true
    }
  ]
}
```

The process exited 0. The host application imports a module with a 243-byte file name. Its `.deno-transpiled` child path would be 259 bytes, so the module has the indexed path `deno-vfs/1`, and the script read both regions back from the extraction. The script also set the `namesz` of the Linux target's `SUI` note to `0x7fffffff`. With no note confirmed, `inspect-artifact` reported root format `elf`. Windows output is the requested path plus `.exe`. The Intel macOS target uses the `<~sui-data~>` trailer. The arm64 host uses the `__SUI,d3n0l4nd` section.
