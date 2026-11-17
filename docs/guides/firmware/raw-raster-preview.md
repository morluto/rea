# Experimental raw raster preview

Use this unregistered file tool when the pixel layout is already known. It does
not discover image boundaries, register a provider or replace the
[structured raster CLI/MCP workflows](structured-raster-discovery.md).

## Running this branch's experiment

Use the pinned Node version and install the locked dependencies with `npm ci`.
From the repository root, the file workflow is:

```sh
node --import tsx scripts/experiments/raw-raster-file.mjs --help
node --import tsx scripts/experiments/raw-raster-file.mjs --max-memory-mib 128 INPUT_FILE LAYOUT_JSON NEW_OUTPUT_DIRECTORY
```

For example, a JSON layout for two RGB888 rows with a one-byte prefix and one
inter-row padding byte is:

```json
{
  "offset": 1,
  "length": 13,
  "width": 2,
  "height": 2,
  "format": "rgb888",
  "stride": 7,
  "rowOrder": "top-down"
}
```

For `indexed4`, use `format: "indexed4"`, `bitOrder: "msb-first"` or
`"lsb-first"`, and `palette` containing exactly 16 `[R,G,B,A]` integer tuples
(each component 0–255). Stride is still bytes, with at least `ceil(width / 2)`
bytes per row. The unused final nibble in an odd-width row is ignored. Palette
entries are copied during validation and preserved in the manifest, including
straight alpha. Container-specific LUT/CLUT conversion is the caller's job; the
core neither infers a palette nor parses firmware resources.

Supply values matching your file; this is an example, not automatic detection.
The destination must not exist and its parent directory must already exist. The
script writes `preview.png` and `manifest.json`, leaving the source unchanged.
The manifest hashes the complete selected range, records its original file offset
and describes the source metadata check without claiming REA subject identity.
By default the manifest contains no source paths or filenames, including no
relative spelling or basename. `sourceSnapshot` retains only size and the observed
stability-check statement, not device/inode identifiers or timestamps. Hashes,
range, layout and output metadata remain available for comparison. Canonical
resolution and descriptor checks still happen internally; privacy does not weaken
source validation.

Only explicit `--include-source-paths` (API `includeSourcePaths: true`) adds
`sourcePath` with the original spelling and `sourceResolvedPath` with the verified
canonical absolute path. The CLI warns that these values can reveal usernames and
local directory/filename information. Use the option only when needed and inspect
the result before sharing. Previously generated manifests are not rewritten;
remove their path/identity fields before sharing or regenerate without the option.
The tool does not upload results. PNG content and palette may themselves be
sensitive, so absence of paths does not make arbitrary outputs safe to publish.
Leaf symlinks and non-regular source files are rejected. Layout JSON is limited to
64 KiB. `--max-memory-mib N` selects a conservative working-buffer estimate budget
(default 64 MiB, integer 1–512), not a process RSS limit. Admission includes selected
input, RGBA, PNG filter rows, worst-case default-deflate output and encoding copies.
It happens before reading selected pixel bytes. The manifest records the selected
budget and estimate. These are experimental script allowances, not REA settings.

For `R = width × height × 4`, `F = R + height`, the estimate is selected input
length + R + F + 5 × (compressBound(F) + 64) + 512 KiB. The last allowance covers
zlib workspace and small framing buffers. Runtime baseline, allocator retention
and unrelated resident input are not covered. Reduce the selected range/layout
or raise the explicit budget when admission reports capacity exhaustion.

Output serialization happens before claiming the destination. After claiming it,
`.incomplete` is created before PNG/manifest writes and removed only on success.
On an I/O error the script exits unsuccessfully and reports the retained directory;
the marker remains if it could be created. Inspect or remove that directory before
retrying. No automatic recursive cleanup can erase unrelated files.

A synthetic demo and focused test commands are also available:

```sh
npm run test:raw-raster
node --import tsx scripts/experiments/raw-raster-preview.mjs /tmp/rea-raster-preview-new
```

The `Experimental raw raster` workflow runs `npm run test:raw-raster` on Linux
and Windows for relevant pushes and pull requests, and supports manual dispatch.
This explicitly includes the Node `.test.mjs` harness, which is not discovered by
Vitest. It uses synthetic temporary files only; it does not upload outputs. The
Linux descriptor-count check and selected leaf-symlink fixture are platform-scoped
and are skipped on Windows. A green Windows job does not claim those checks ran.

The synthetic demo uses red/green/blue/white pixels only. Neither script is a
registered REA product command or supported public API. File-workflow verification
is distinct from pure decoder checks; see the
[verification scope](../../specs/artifacts/raw-raster-preview/plan.md#verification-scope).
