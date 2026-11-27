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
| `bink2`                 | `KB2` plus a lowercase revision letter                     | Bink 2 leading header and frame-offset table |
| `vulkan-pipeline-cache` | `headerSize` 32 and `VK_PIPELINE_CACHE_HEADER_VERSION_ONE` | Vulkan pipeline cache VersionOne header      |

Each signature needs only the bytes that carry it: the RIFF claim stops at the
fmt tag (22 bytes), Bink at the revision letter (4 bytes) and Vulkan at the
size and version words (8 bytes). A file cut off after its signature is
recognized, and inspection refuses it as truncated with the bytes it needs.

## What each format reports

- **Ogg Opus**: stream serials and page sequences for the examined
  identification and comment pages; OpusHead channel count, pre-skip, input
  sample rate, output gain and mapping family; OpusTags vendor when the
  comment packet is complete and the vendor string fits the fixed 4096-byte
  root-fact bound. Regions are each examined page and, after a finished
  comment packet, `audio.bin` for the remaining bytes. OpusTags packets that
  continue across pages are followed until the lacing table ends the packet;
  continued comment bytes are never folded into `audio.bin`. Pages of other
  logical streams between the Opus header pages are listed and named in a
  limitation; OpusTags is read only from the OpusHead stream's serial, as
  opusfile does. Header fields are read only inside their own packet,
  as the page's lacing table delimits it, never from a later packet on the
  same page. A vendor that is not UTF-8, an OpusHead page without the
  beginning-of-stream flag or carrying another packet, and a page that ends
  OpusTags and starts another packet are reported as limitations.
- **RIFF/XMA2**: the RIFF declared size, each chunk id/offset/length inside
  the form, and the `fmt ` tag 0x166 fields (channels, rate, block align,
  bits). The fmt chunk is the first chunk, which recognition requires; a
  later fmt chunk is noted and not interpreted. `fmt_extra_bytes` (cbSize) is
  null when the fmt chunk is too short to hold it. When the fmt holds the
  52-byte XMA2WAVEFORMATEX, the root also reports stream count,
  channel mask, samples encoded, block and loop fields. Chunk headers and
  the fmt fields are read by position; opaque chunk payloads are not loaded
  during inventory. The walk stays inside the RIFF form end. Entry names use
  the chunk FourCC only when it is alphanumeric; other chunks are named
  `chunks/<index>.bin` and keep their exact ID in `chunks[].id`.
- **Bink 2**: the header words at the offsets FFmpeg's Bink demuxer reads:
  revision (and printable revision character), frame count, largest frame
  size, width, height, frame-rate numerator and denominator, video flags,
  audio track count, and each audio track's max decoded size, sample rate,
  raw flags and ID. Revisions `i`, `j` and `k` carry one more header word
  before the track tables. Regions are `frame-offsets.bin` and, when present,
  opaque `frames.bin`. For a revision FFmpeg does not read, or for video flags
  `0x4` or `0x10000`, after which vgmstream reads further header words that
  FFmpeg does not, the tables are not located: their offset is null and
  coverage is unknown. More than 256 audio tracks refuses as malformed, as in
  both demuxers.
- **Vulkan pipeline cache**: VersionOne `headerSize`, `headerVersion`,
  `vendorID`, `deviceID` and `pipelineCacheUUID`. Regions are `header.bin`
  and opaque `opaque.bin`.

## Declared extents that disagree

`extent_check` is `consistent`, `truncated` or `trailing-bytes`. A
disagreement is reported as a fact, not a refusal:

- A truncated Ogg page after OpusHead keeps the pages already read and
  reports unknown coverage. A file that ends after OpusHead, before the
  OpusTags packet RFC 7845 requires, is `truncated` with unknown coverage. A first page whose declared payload runs past
  EOF refuses with a truncated-input failure, not malformed.
- A RIFF chunk whose payload does not fit inside the declared RIFF end is
  not listed. An odd-sized final chunk whose pad byte is omitted at the form
  end stays listed with a limitation; a partial trailing chunk header inside the form
  makes coverage unknown. Bytes after the RIFF end are trailing and are not
  inventoriable WAVE members.
- A Bink frame-offset table that ends past the file is not listed. A region
  is never clipped.

Coverage is `complete` only when `extent_check` is `consistent` and every
declared header region was examined.

## Limits

RFC 3533 does not bound the pages that carry the Opus header packets, and
RIFF does not bound its chunk count, so the regions one container lists are
admitted against `artifact_limits.media_asset.region_count` (default
100,000). The Ogg page walk, the RIFF chunk walk and the final region list
(including `audio.bin` and the fixed Bink and Vulkan regions) all count
against it. Past it, inspection refuses with `details.limit` naming that
field; raise it on the next call:

```json
{ "artifact_limits": { "media_asset": { "region_count": 200000 } } }
```

The OpusTags vendor is delivered inline as the root `vendor` fact only up to
4096 bytes. That is a delivery bound, not an admission: a longer vendor is
omitted from the root with a limitation and stays complete in the extractable
comment pages. Bink frame counts are not capped: the frame-offset table is a
declared byte range and is never loaded during inventory.

## CLI

```sh
rea inspect-artifact sample.opus --detail summary --json
rea extract-artifact voice.xma --json
```

## Verification scope

Synthetic fixtures cover each format's header facts, regions, truncation,
spanned OpusTags, interleaved Ogg streams, RIFF trailing bytes and omitted
pad bytes, Bink audio track tables and revisions, and a malformed Vulkan
`headerSize`. A Bink header written at absolute offsets checks the field
positions independently of the fixture builder. No real encoder output was
inspected. Sources: RFC 3533, RFC 7845 and opusfile for Ogg Opus; FFmpeg
`libavformat/wavdec.c` and `riffdec.c` and the public xma2defs.h layout for
RIFF/XMA2; FFmpeg `libavformat/bink.c` and vgmstream `src/meta/bik.c` for
Bink 2; the Vulkan specification's `VkPipelineCacheHeaderVersionOne`.
