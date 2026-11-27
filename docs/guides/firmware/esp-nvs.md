# ESP-IDF Non-Volatile Storage (NVS) partitions

`inspect_esp_nvs` (`rea inspect-esp-nvs`) decodes ESP-IDF v1 and v2 Non-Volatile
Storage (NVS) flash partitions directly from either a carved `nvs.bin` file or a
4096-byte aligned slice of a raw ESP32/ESP8266 SPI flash dump without executing
target code.

## When to use it

When `inspect_artifact` classifies a standalone carved partition as `esp-nvs`
or reports a populated `data/nvs` partition inside an `esp-flash-image` dump
(typically at `0x9000`), use `inspect_esp_nvs` to inspect its persisted
configuration state:

- Verify 4096-byte NVS page headers, sequence numbers, v1/v2 format markers,
  and 2-bit slot state bitmaps (`empty`, `written`, `erased`, plus a count of
  `illegal` slots). Page `state` is ESP-IDF's `PageState`: `empty`, `active`,
  `full`, `freeing`, `corrupt` (0xfffffff0, written by firmware), `invalid` (0)
  or `unknown`. `header_crc_valid` is reported separately, and
  `entries_decoded` says whether the page's entries were walked: only a valid
  header in the `active`, `full` or `freeing` state is.
- Reconstruct namespace tables (`ns_index = 0`), primitive settings (`u8`..`u64`,
  `i8`..`i64`, and `float`/`double` as `value_float`), UTF-8 strings (`sz`), v1
  single-page blobs, and v2 multi-chunk `BLOB_IDX` + `BLOB_DATA` payloads with
  SHA-256 digests and bounded hex previews.
- Mark `superseded: true` on an older copy of a namespace, key and type that a
  newer copy replaces: a higher page sequence number, or a later slot on the
  same page. An interrupted rewrite or page move leaves both copies; ESP-IDF
  reads the newer one.
- Verify ESP-IDF `esp_rom_crc32_le(0xFFFFFFFF, ...)` checksums on every page
  header, 32-byte item header, and variable-length payload, and apply ESP-IDF's
  item-header consistency rules (`Item::checkHeaderConsistency`): span per
  type, chunk index, and a variable item's span matching its length. An item
  that fails either is not trusted; the walk advances one slot so later intact
  keys remain visible, and the page's `inconsistent_item_count` counts it.

## CLI and MCP usage

```bash
# Standalone carved NVS partition
rea inspect-esp-nvs partitions/nvs.bin

# Directly inside a full ESP32 flash dump (offset 0x9000 = 36864, size 0x6000 = 24576)
rea inspect-esp-nvs esp32_flash.bin --partition-offset 36864 --partition-bytes 24576

# Summarize inline while retaining the complete decoded NVS Evidence bundle
rea inspect-esp-nvs partitions/nvs.bin --detail summary --evidence_output nvs.evidence.json
```

In MCP sessions, `detail: "summary"` (or omitted `detail` when the complete
report exceeds the agent result budget, or an explicit inline `max_entries` cap)
retains the complete decoded NVS Evidence so later entries, pages, namespaces,
and anomalies can be paged with `inspect_analysis_view` (`kind: "esp-nvs"` or
`kind: "evidence-json"`).

## Provenance and limitations

- Stored keys and values are preserved verbatim as local artifact observations.
- Decoded page summaries, namespaces, entries, and anomalies are accounted
  against `max_decoded_bytes` (default 32 MiB, up to 128 MiB) before report
  allocation; narrow full-flash dumps to the NVS region with `partition_offset`
  and `partition_bytes`, or raise `max_decoded_bytes` within its ceiling.
- Explicit `partition_offset` and `partition_bytes` selections that extend past
  the input file are rejected rather than silently truncated.
- XTS-AES encrypted NVS partitions are not decrypted. NVS encryption keeps page
  headers and entry-state bitmaps in plaintext and encrypts each entry, so an
  encrypted page has a valid header and every written item header unreadable;
  an anomaly says so and coverage is `partial`. Whole-flash encryption makes the
  page header itself fail CRC32, so the page is not decoded.
- Strings and keys that are not valid UTF-8 are not replaced: a string keeps its
  bytes as a blob digest and preview, and a key is shown byte-for-byte as
  Latin-1, each with an anomaly.
- Orphan `BLOB_DATA` chunks without a matching `BLOB_IDX` record are surfaced
  with `data_type: "blob_data_orphan"` and `completeness: "missing_chunks"`.
  An older copy of a chunk whose newer copy a recovered blob used, which an
  interrupted page move leaves, is `data_type: "blob_data_copy"` with
  `superseded: true`, and does not make coverage partial.

## Sources

The layout follows ESP-IDF's own implementation in `components/nvs_flash`:
`nvs_constants.h` (page states, entry states and offsets), `nvs_types.cpp`
(`Item::checkHeaderConsistency`), `nvs_handle.hpp` (item types, including
`FLOAT` 0x24 and `DOUBLE` 0x28), and the
[NVS encryption documentation](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/storage/nvs_encryption.html).
ESP-IDF's offline `nvs_partition_tool/nvs_parser.py` labels page state 0 as
"Corrupted" and does not name 0xfffffff0; REA follows the firmware constants,
where 0 is `INVALID` and 0xfffffff0 is `CORRUPT`.
