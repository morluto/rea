# Deno compile executables

`inspect-artifact` inventories a `deno compile` executable. `extract-artifact` writes the embedded virtual files through the existing safe output tree. Neither operation runs the executable or the Deno runtime.

```sh
rea inspect-artifact ./app --json
rea extract-artifact ./app --json
```

In MCP, open the executable with `open_binary`, then call `inspect_artifact`. Use `detail: "summary"` for a large virtual filesystem and `inspect_analysis_view` to page retained Evidence.

The recognized carriers are a Mach-O `__SUI` section named `d3n0l4nd`, an Intel Mach-O `<~sui-data~>` trailer, an ELF `PT_NOTE` or `SHT_NOTE` owned by `SUI` with type `0x53554901` and descriptor name `d3n0l4nd`, and a PE `RT_RCDATA` resource named `D3N0L4ND`. These are structural layouts. The metadata JSON has no Deno version field, so the compiler version stays unknown unless another record establishes it. Other layouts, including older eszip trailers, are unsupported.

Root metadata reports the carrier, entry point, argv, V8 flags, permission options, unstable configuration, application name, self-extracting marker, virtual-filesystem case sensitivity, and the npm snapshot byte length. The npm snapshot is not decoded. Each virtual file is one occurrence with its logical path, size, and SHA-256. Transpiled output, CJS export analysis, and source maps are separate occurrences beside that file. Each has the same `index` as the file and its own `role`. A region normally has the logical path of the file plus a `.deno-*` suffix. When that path belongs to another stored file, the region moves to an indexed path such as `deno-vfs/0.vfs-transpiled`, so read the reported `logical_path` instead of building it from the file name. They are not linked by `parent_occurrence_id`, which follows directories and expanded containers. Symlink targets stay recorded path parts and are never followed.

`Metadata.env_vars_from_env_file` holds values from a compile-time `--env-file`, and `ca_data` holds certificate bytes. Inventory retains the variable names and values, certificate bytes, counts, and byte lengths in local Evidence, so sharing that Evidence shares them. Extraction does not write them as files.

A virtual filesystem that cannot be listed reports `vfs_listing` as `unsupported` and leaves inventory and extraction coverage unknown, because its files are not examined.

Remote modules, redirects, and specifiers contribute counts and logical paths when their stored form is unambiguous. When it is not, they stay present with a byte length and an `unsupported` member listing. A module whose specifier is missing uses an indexed `deno-remote/<index>` path, which still exposes its stored bytes, and modules with resolved specifiers keep their paths. Colons, backslashes, and control characters in a specifier are percent-encoded in the logical path, so `http://localhost:8000/mod.ts` becomes `deno-remote/localhost%3A8000/mod.ts`. `source_path` keeps the original specifier. A remote specifier is indexed the same way when a path component exceeds 255 UTF-8 bytes or the logical path exceeds 512 UTF-8 bytes, counting the `.deno-*` suffix of its stored regions. Unsafe, deep, or over-long virtual names use `deno-vfs/<index>` under the same rule and retain the original spelling when it fits the name allowance. A descendant does not present its own name as a complete source path when an ancestor spelling was dropped.

A length that overruns the section, or a closing marker that does not match, is malformed. An opening marker that is absent is unsupported. A confirmed section that cannot be parsed fails closed and does not fall through to a plain native inventory. An Intel Mach-O sentinel inside a confirmed trailer payload is data of that payload, so an Intel Deno executable stored as a virtual file does not replace the app that stores it. Trailers side by side with different bytes fail closed. A file is confirmed only by its carrier name, so an unrelated native file with malformed tables keeps its native inventory. That inventory does not establish that the file holds no Deno section.

See [limits and recovery](design/limits-and-recovery.md) for the named allowances. Synthetic tests cover the carriers and malformed declarations. Run `npm run verify:deno:standalone` for a local Deno compile of the host and, when the compiler can produce them, Linux, Windows, and Intel macOS targets. Deno is a fixture producer only and is not installed by REA. The produced executable is not run.

Layout reference: Deno `cli/lib/standalone/binary.rs` and `cli/lib/standalone/virtual_fs.rs` at 2.9.8, with libsui 0.16.4 section placement.
