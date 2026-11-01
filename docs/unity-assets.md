# Unity WebGL data and SerializedFiles

Unity builds ship their scenes and assets in SerializedFiles (`level0`,
`sharedassets0.assets`, `globalgamemanagers`, `resources.assets`, `CAB-*`
bundle members). REA reaches them through two read-only layers that never run
the player or require Unity:

1. **Containers.** `inspect-artifact` and `extract-artifact` read the Unity
   WebGL `.data` container (`UnityWebData1.0`) and [UnityFS](unityfs.md)
   AssetBundles. WebGL builds usually nest a UnityFS `data.unity3d` inside the
   `.data` file.
2. **Objects.** `inspect_unity_assets` / `inspect-unity-assets` inventories one
   extracted SerializedFile: object counts per class, meshes, textures,
   materials and root GameObjects.

```bash
rea extract-artifact Build.data --json                 # boot.config, data.unity3d, Il2CppData/…
rea extract-artifact /tmp/out/data.unity3d --json      # level0, sharedassets0.assets, …
rea inspect-unity-assets /tmp/out2/level0 --json
```

MCP requires an absolute filesystem path:

```json
{
  "name": "inspect_unity_assets",
  "arguments": { "path": "/artifacts/build/sharedassets0.assets" }
}
```

## WebGL data container

Detection uses the 16-byte `UnityWebData1.0\0` signature, not the file name.
Browsers save `Build.data.gz` or `Build.data.br` after removing the transfer
encoding, so these names often hold the plain container. A file that really is
gzip-compressed is not decoded; decompress it with an external utility first.

The container metadata retains the signature, the declared directory end and
the member count. Each member keeps its stored name, index and declared offset.
Members are stored without compression and stream directly from the carrier.
A truncated record, a name that exceeds the directory, a member outside the
file and a duplicate member name are malformed-input errors. The directory is
limited to 16 MiB and readable member bytes share the archive expansion budget.
Members such as `Il2CppData/Metadata/global-metadata.dat` can then be inspected
with [`inspect_il2cpp_metadata`](il2cpp-metadata.md).

## SerializedFile inventory

`inspect_unity_assets` reads one stable regular file (`max_file_bytes`, default
512 MiB, maximum 1 GiB) and decodes SerializedFile formats 14 through 22
(Unity 5.0 through Unity 6), in either declared endianness. The result
contains:

- `header`: format version, metadata size, file size, data offset and
  endianness; `unity_version`, `target_platform`, `type_tree_enabled`.
- `class_counts`: objects per class ID, sorted by count, with common class
  names (`GameObject`, `Mesh`, `MonoBehaviour`…). Other IDs keep a null name.
- `externals`: referenced files with the PPtr `file_id` that selects them.
- `meshes`: name, submesh count, total index count and `submesh_vertex_extent`.
- `textures`: name, width, height and the stored `TextureFormat` value.
- `materials`: name and shader PPtr.
- `root_game_objects`: Transforms or RectTransforms without a parent in this
  file, with the owning GameObject's name, active flag, component count,
  direct child count and local position.

Path IDs are signed 64-bit values and are reported as decimal strings.

## Coverage and limits

Object fields are read with fixed Unity 5.5+ serialization layouts selected by
the declared Unity version, not from embedded type trees. An object that does
not match its layout keeps null fields, is counted in
`coverage.undecoded_objects` and makes coverage `partial`. Producers older than
5.5, or with an unparsable version, return counts and tables with no decoded
fields. A malformed header or metadata table fails without partial success.

`submesh_vertex_extent` is the largest `firstVertex + vertexCount` across a
mesh's submeshes. It is derived from submesh ranges and is not
`m_VertexData.m_VertexCount`. Vertex buffers, texture pixels, shader programs,
MonoBehaviour fields and the full GameObject hierarchy below the roots are not
decoded. PPtrs with a nonzero `file_id` refer to `externals` and are not
resolved across files. A UnityWebData or UnityFS input is refused with
`extract_artifact` as the next step.

## Verification scope

Synthetic fixtures cover formats 17 and 22, the container's malformed
directories, signed path IDs, layout mismatches and pre-5.5 producers. A
privately held WebGL build (Unity 2020.3.0f1, UnityFS format 7 with LZ4HC
blocks) was walked through both container layers and every SerializedFile.
Its totals of 206 Mesh, 154 Texture2D and 3,736 GameObject objects matched
UnityPy 1.24.2. That build is not redistributed.
