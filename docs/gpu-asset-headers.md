# GPU asset headers: DDS, GLB, KTX and KTX2

`inspect-artifact` and `extract-artifact` read the declared headers of four
GPU asset containers without decoding them. Each one is inventoried as a
container. Its root `format_metadata` holds the header facts, and each
declared byte region is a member that can be hashed, classified and
extracted. Texture, mesh and image payloads are never decoded,
decompressed or transcoded.

Detection reads the bytes, so the file name does not matter:

| Format | Signature                                  | Specification                                           |
| ------ | ------------------------------------------ | ------------------------------------------------------- |
| `dds`  | `DDS ` then a DDS_HEADER whose size is 124 | Microsoft DDS_HEADER, DDS_PIXELFORMAT, DDS_HEADER_DXT10 |
| `glb`  | `glTF`, container version 2                | glTF 2.0 "Binary glTF Layout"                           |
| `ktx`  | `«KTX 11»` identifier                      | Khronos KTX 1.1                                         |
| `ktx2` | `«KTX 20»` identifier                      | Khronos KTX 2.0                                         |

## What each format reports

- **DDS**: flags, width, height, depth, pitch, mip count, pixel-format flags,
  FourCC, RGB bit count and caps. When the FourCC is `DX10`, the root also
  reports the DXGI format number and name, the resource dimension, misc flags
  and the array size. The payload after the header is one region,
  `payload.bin`. For block-compressed formats (BC1–BC7, DXT1–DXT5, ATI1/ATI2)
  and common uncompressed formats, `expected_payload_bytes` is derived from
  the dimensions, mips, cube faces, array layers and volume depth. Otherwise
  it is null.
- **GLB**: version, declared length and the chunk table. The `asset.version`
  and `asset.generator` fields come from the JSON chunk, along with the
  length of every top-level array (`counts`, for example `meshes` or
  `accessors`) and `extensionsUsed`. Regions are the JSON chunk, the BIN
  chunk and each image stored in the BIN chunk through a `bufferView`, named
  by its `mimeType` (`images/<n>.png`). An embedded image therefore gets its
  own content hash. `external_images` counts images stored outside the GLB,
  either named by a URI or held in a buffer that has a URI. These are not
  regions of the file and do not make coverage unknown. An image whose
  `bufferView` resolves to neither is not listed, and coverage is `unknown`.
- **KTX 1.1**: endianness, the GL type and format fields, dimensions, array
  elements, faces, mip levels and key/value byte count. Regions are the
  key/value data and one region per mip level. The level region holds the
  bytes after that level's `imageSize` field, which is six padded faces for
  a non-array cube map.
- **KTX2**: `vkFormat`, type size, dimensions, layer, face and level counts,
  and the supercompression scheme (`none`, `BasisLZ`, `Zstandard`, `ZLIB`).
  The root also reports the DFD, KVD and SGD extents and the level index
  (offset, length and uncompressed length per level). Each non-empty extent
  and each level is a region.

## Declared extents that disagree

`extent_check` is `consistent`, `truncated` or `trailing-bytes`. A
disagreement is reported as a fact, not a refusal:

- A truncated DDS keeps its partial `payload.bin` and reports
  `payload_bytes` next to `expected_payload_bytes`.
- A GLB, KTX or KTX2 region that ends past the file is not listed. A region
  is never clipped. A limitation names the region and the file end.
- Bytes after every declared region are counted in a limitation.

Coverage is `complete` only when `extent_check` is `consistent`.

A header that breaks its format's structure refuses with a malformed-input
error that names the format and offset. Examples are a DDS_PIXELFORMAT
whose size is not 32, a GLB whose first chunk is not JSON or whose chunk
length is not 4-byte aligned, a KTX endianness marker that is neither byte
order, and a level count above 32. The GLB JSON chunk is parsed for counts
only up to 16 MiB. A larger or invalid JSON chunk stays a region, and
`json_status` says why no counts were read.

## CLI

```sh
rea inspect-artifact Duck.glb --detail summary --json
rea extract-artifact texture.ktx2 --json
```

## Verification scope

Synthetic fixtures built from the specifications cover each format's header
facts, regions, a truncated case and a malformed case. Public files checked,
all `consistent`:

- KhronosGroup/glTF-Sample-Assets `Duck.glb`: two chunks and one 16,302-byte PNG image.
- KhronosGroup/KTX-Software `bc3_unorm_array_7.ktx`: seven 256x256 BC3 layers in 458,752 bytes.
- `kodim23.ktx2`: BasisLZ, with DFD, KVD, SGD and one level.
- ImHex-Patterns `dds.hexpat.dds`: DXT1 64x64, 2,048 payload bytes.

Ogg Opus, RIFF/XMA2, Bink 2 and Vulkan pipeline caches are covered by the
[media asset headers](media-asset-headers.md) guide.
