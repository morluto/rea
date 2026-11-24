# Deno compile executables

`inspect-artifact` inventories a `deno compile` executable. `extract-artifact` writes the embedded virtual files through the existing safe output tree. Neither operation runs the executable or the Deno runtime.

```sh
rea inspect-artifact ./app --json
rea extract-artifact ./app --json
```

In MCP, open the executable with `open_binary`, then call `inspect_artifact`. Use `detail: "summary"` for a large virtual filesystem and `inspect_analysis_view` to page retained Evidence.

The recognized carriers are a Mach-O `__SUI` section named `d3n0l4nd`, an Intel Mach-O `<~sui-data~>` trailer, an ELF `PT_NOTE` or `SHT_NOTE` owned by `SUI` with type `0x53554901` and descriptor name `d3n0l4nd`, and a PE `RT_RCDATA` resource named `D3N0L4ND`. These are structural layouts. The metadata JSON has no Deno version field, so the compiler version stays unknown unless another record establishes it. Other layouts, including older eszip trailers, are unsupported.

The PE probe follows the DOS header's PE offset and reads the declared header
records and matching resource directories by file position. After confirming
the resource name, it reports malformed ranges separately from the fixed
65,536-entry inspection allowance. It validates the declared extent of a
different-length name without reading that name's bytes.

The ELF probe skips malformed section tables, including tables with a reserved
direct `e_shnum` count, and still checks independently readable program
headers. A program note that confirms the Deno carrier alongside such damage
produces a format error.

Root metadata reports the carrier, entry point, argv, V8 flags, permission options, unstable configuration, application name, self-extracting marker, virtual-filesystem case sensitivity, and the npm snapshot byte length. The npm snapshot is not decoded. Each virtual file is one occurrence with its logical path, size, and SHA-256. Transpiled output, CJS export analysis, and source maps are separate occurrences beside that file. Each has the same `index` as the file and its own `role`. A region normally has the logical path of the file plus a `.deno-*` suffix. When that path belongs to another stored file, the region moves to an indexed path such as `deno-vfs/0.vfs-transpiled`, so read the reported `logical_path` instead of building it from the file name. They are not linked by `parent_occurrence_id`, which follows directories and expanded containers. Symlink targets stay recorded path parts and are never followed.

`Metadata.env_vars_from_env_file` holds values from a compile-time `--env-file`, and `ca_data` holds certificate bytes. Inventory retains the variable names and values, certificate bytes, counts, and byte lengths in local Evidence, so sharing that Evidence shares them. Extraction does not write them as files.

A virtual filesystem that cannot be listed reports `vfs_listing` as `unsupported` and leaves inventory and extraction coverage unknown, because its files are not examined.

Remote modules, redirects, and specifiers contribute counts and logical paths when their stored form is unambiguous. When it is not, they stay present with a byte length and an `unsupported` member listing. A module whose specifier is missing uses an indexed `deno-remote/<index>` path, which still exposes its stored bytes, and modules with resolved specifiers keep their paths. Colons, backslashes, and control characters in a specifier are percent-encoded in the logical path, so `http://localhost:8000/mod.ts` becomes `deno-remote/localhost%3A8000/mod.ts`. Percent escapes in a logical path use uppercase hex, and a specifier that reaches a path already taken uses an indexed path. `source_path` keeps the original specifier. A remote specifier is indexed the same way when a path component exceeds 255 UTF-8 bytes or the logical path exceeds 512 UTF-8 bytes, counting the `.deno-*` suffix of its stored regions. Unsafe, deep, or over-long virtual names use `deno-vfs/<index>` under the same rule and retain the original spelling when it fits the name allowance. A descendant does not present its own name as a complete source path when an ancestor spelling was dropped.

A length that overruns the section, or a closing marker that does not match, is malformed. An opening marker that is absent is unsupported. A confirmed section that cannot be parsed fails closed and does not fall through to a plain native inventory. An Intel Mach-O sentinel inside a confirmed trailer payload is data of that payload, so an Intel Deno executable stored as a virtual file does not replace the app that stores it. Trailers side by side with different bytes fail closed. A file is confirmed only by its carrier name, so an unrelated native file with malformed tables keeps its native inventory. That inventory does not establish that the file holds no Deno section.

Named allowances are in [Deno compile sections](#deno-compile-sections). Synthetic tests cover the carriers and malformed declarations. Run `npm run verify:deno:standalone` for a local Deno compile of the host and, when the compiler can produce them, Linux, Windows, and Intel macOS targets. Deno is a fixture producer only and is not installed by REA. The produced executable is not run.

Layout reference: Deno `cli/lib/standalone/binary.rs` and `cli/lib/standalone/virtual_fs.rs` at 2.9.8, with libsui 0.16.4 section placement.

## Deno compile sections

`MAX_DENO_METADATA_JSON_BYTES` admits at most 8 MiB of metadata JSON.
`MAX_DENO_VFS_HEADER_JSON_BYTES` admits at most 32 MiB of virtual-filesystem
header JSON. Specifier, redirect, and remote tables each admit at most 100,000
records. Specifier text admits at most 8 MiB, and remote module bodies admit at
most 256 MiB. The virtual filesystem admits at most 100,000 directory, file,
and symlink records and at most 512 nested levels (`MAX_DENO_VFS_DEPTH`). A
name longer than 4,096 UTF-16 code units is indexed and is not retained.
`MAX_DENO_VFS_RETAINED_UNITS` admits at most 32 million UTF-16 code units across
the source path built for every entry, directories included, and retained
symlink parts. A logical path deeper than 256 parts, a name that is not a safe
relative path, a path component longer than 255 UTF-8 bytes
(`MAX_DENO_PATH_COMPONENT_BYTES`, POSIX `NAME_MAX`), or a logical path longer
than 512 UTF-8 bytes (`MAX_DENO_LOGICAL_PATH_BYTES`, half of the Darwin
`PATH_MAX`) uses an indexed path and keeps the original spelling when that
spelling is within the name allowance. Component and path lengths include the
`.deno-*` suffix of the stored regions a member has. A descendant has no source
path when an ancestor spelling was not retained. Cancellation is checked before
the virtual-filesystem walk. The walk does not yield, so it does not observe a
cancellation that arrives while it is running; the retained allowance bounds its
work. The combined logical path tree admits at most 250,000 distinct prefixes.
`MAX_DENO_RETAINED_BYTES` admits at most 256 MiB of retained header and entry
metadata. The shared artifact expansion budget also bounds the sum of referenced
member lengths, with a 256 MiB floor.

Carrier location claims a file only after it confirms the carrier name: a
Mach-O `__SUI` segment, a `SUI` ELF note descriptor named `d3n0l4nd`, a PE
`D3N0L4ND` resource, or an Intel trailer opening with `d3n0l4nd`. Before that,
malformed tables and exhausted search budgets leave the file with native
inventory, and that inventory makes no claim that the file holds no Deno
section. ELF location reads ELF and note headers, not the whole image, and does
not hash note descriptors. An ELF larger than 512 MiB is still located when
those headers fit. Program and section tables are read at their canonical record
size, so the 16-bit header count bounds each read at 65,535 records. A table
that cannot be read, or that uses extended program numbering, is skipped and
another table can still hold the note. At most 256 notes are examined
(`MAX_INSPECT_ELF_NOTE_ENTRIES`). A damaged table or the note ceiling is a
refusal only when a `SUI` note was also confirmed. Intel Mach-O trailer search
reads each scanned byte at most once and examines at most 64 `<~sui-data~>`
sentinels (`MAX_DENO_INTEL_TRAILER_SENTINELS`). The search continues past a
confirmed trailer, because an enclosing trailer can hold it as a stored file, so
reaching that allowance after a confirmation is a refusal. PE location walks the resource directories to the named payload and
does not read the image whole, so a PE of any size is located when the
`D3N0L4ND` payload is within the 512 MiB resource reader ceiling. A larger
payload, or a confirmed resource that cannot be resolved, is a named refusal.
Refusals name the boundary. There is no runtime override; additional host memory
or `NODE_OPTIONS` does not raise these ceilings. Duplicate-section verification
rejects unequal lengths before hashing, stops at the first digest mismatch,
and reads at most the carrier file size in aggregate
payload bytes. Overlapping copies that exceed that allowance are refused.
Environment-file values and CA certificate bytes are retained in local Evidence
with their counts and byte lengths. The npm snapshot length is retained and its
bytes are not decoded.
