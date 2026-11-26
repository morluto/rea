# Media asset headers: Ogg Opus, RIFF/XMA2, Bink 2 and Vulkan pipeline cache

`inspect-artifact` and `extract-artifact` read the declared headers of four
media and GPU-cache containers without decoding their payloads. Each one is
inventoried as a container. Its root `format_metadata` holds the header
facts, and each declared byte region is a member that can be hashed,
classified and extracted. Audio frames, video frames and vendor-private
pipeline-cache bodies stay opaque.

Detection reads the bytes, so the file name does not matter:

| Format                  | Signature                                                  | Specification                                |
| ----------------------- | ---------------------------------------------------------- | -------------------------------------------- |
| `ogg-opus`              | `OggS` page whose first packet starts with `OpusHead`      | RFC 7845 Opus in Ogg                         |
| `riff-xma2`             | `RIFF`…`WAVE` with `fmt ` tag `0x166` (`WAVE_FORMAT_XMA2`) | RIFF WAVE plus XMA2WAVEFORMATEX              |
| `bink2`                 | `KB2` plus a revision byte                                 | Bink 2 leading header and frame-offset table |
| `vulkan-pipeline-cache` | `headerSize` 32 and `VK_PIPELINE_CACHE_HEADER_VERSION_ONE` | Vulkan pipeline cache VersionOne header      |

## What each format reports

- **Ogg Opus**: stream serials and page sequences for the examined
  identification and comment pages; OpusHead channel count, pre-skip, input
  sample rate, output gain and mapping family; OpusTags vendor when the
  comment packet is complete and the vendor string fits the fixed 4096-byte
  root-fact bound. Regions are each examined page and, after a finished
  comment packet, `audio.bin` for the remaining bytes. OpusTags packets that
  continue across pages are followed until the lacing table ends the packet;
  continued comment bytes are never folded into `audio.bin`.
- **RIFF/XMA2**: the RIFF declared size, each chunk id/offset/length inside
  the form, and the `fmt ` tag 0x166 fields (channels, rate, block align,
  bits). When the fmt holds XMA2 extras, the root also reports stream count,
  channel mask, samples encoded, block and loop fields. Chunk headers and
  the fmt fields are read by position; opaque chunk payloads are not loaded
  during inventory. The walk stays inside the RIFF form end.
- **Bink 2**: revision (and printable revision character when present),
  frame count, width, height, frame-rate numerator and denominator, the
  declared size field, and the frame-offset table extent. Regions are
  `frame-offsets.bin` and, when present, opaque `frames.bin`.
- **Vulkan pipeline cache**: VersionOne `headerSize`, `headerVersion`,
  `vendorID`, `deviceID` and `pipelineCacheUUID`. Regions are `header.bin`
  and opaque `opaque.bin`.

## Declared extents that disagree

`extent_check` is `consistent`, `truncated` or `trailing-bytes`. A
disagreement is reported as a fact, not a refusal:

- A truncated Ogg page after OpusHead keeps the pages already read and
  reports unknown coverage. A first page whose declared payload runs past
  EOF refuses with a truncated-input failure, not malformed.
- A RIFF chunk whose payload or padding does not fit inside the declared
  RIFF end is not listed; a partial trailing chunk header inside the form
  makes coverage unknown. Bytes after the RIFF end are trailing and are not
  inventoriable WAVE members.
- A Bink frame-offset table that ends past the file is not listed. A region
  is never clipped.

Coverage is `complete` only when `extent_check` is `consistent` and every
declared header region was examined.

## Fixed inventory ceilings

These walks use fixed ceilings with a stated representation reason; they are
not `REA_` runtime settings:

| Ceiling                                       | Value | Reason                                                                                     |
| --------------------------------------------- | ----- | ------------------------------------------------------------------------------------------ |
| Ogg pages examined for OpusHead/OpusTags      | 64    | Stops page floods from unbounded comment continuations; RFC 3533 does not bound page count |
| RIFF chunks walked inside the WAVE form       | 256   | Stops zero-length chunk floods; RIFF does not bound chunk count                            |
| OpusTags vendor bytes retained as a root fact | 4096  | Metadata-field bound; longer vendors remain in page regions                                |

When a ceiling stops the walk, coverage is `unknown` and a limitation names
the ceiling and that raise is unavailable. Bink frame counts are not capped
by an inventory policy: only unsafe table sizes (non-safe integers) refuse
as malformed.

## CLI

```sh
rea inspect-artifact sample.opus --detail summary --json
rea extract-artifact voice.xma --json
```

## Verification scope

Synthetic fixtures cover each format's header facts, regions, truncation,
spanned OpusTags, RIFF trailing bytes past the form end, and a malformed
Vulkan `headerSize`.
