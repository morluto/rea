# LabVIEW RSRC containers

`inspect_labview_artifact` / `inspect-labview-artifact` inventories one local
LabVIEW artifact: a `.vi`, `.ctl`, or `.llb` file, or a LabVIEW-built
executable whose program tree is stored as a PE resource. It reads the file
without running it and requires no LabVIEW installation, active binary target,
or native-analysis provider.

```bash
rea inspect-labview-artifact /absolute/path/to/example.vi --json
```

MCP requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_labview_artifact",
  "arguments": { "path": "/artifacts/example.vi" }
}
```

## Observations

The result names the selected artifact by path, complete byte count, and
SHA-256, then reports:

- the RSRC header: format version, four-character file type and creator, and the
  data and info ranges;
- the LabVIEW version recorded by the container's `vers` block, when present;
- whether a block-diagram heap (`BDH*`) and a front-panel heap (`FPH*`) are
  present, absent from the inspected container, or unknown because content the
  reader did not examine could still hold one;
- every block identifier with its sections: section index, optional name,
  stored byte count, coding, and the decoded byte count when this reader
  decoded the section.

A LabVIEW-built executable is read through its PE resource directory: the
largest embedded RSRC container is inspected and the count of containers found
is reported. The outer container of a built executable usually holds a `FLAG`
block and one `LVzp` block (the embedded program tree) rather than the per-VI
blocks a source `.vi` carries.

## Coding and decoding

A section is reported with one coding:

| Coding    | Meaning                                                                                             |
| --------- | --------------------------------------------------------------------------------------------------- |
| `none`    | Stored bytes are the section content                                                                |
| `zlib`    | A four-byte big-endian length followed by a zlib stream                                             |
| `xor`     | A LabVIEW XOR-coded block, such as the embedded program tree (`LVzp`)                               |
| `unknown` | A zlib section that did not decode to its declared length, or one the decode budget did not attempt |

Only zlib-coded sections are decoded, and only to establish their decoded byte
count. No section payload is returned; use another tool to extract content once
the inventory identifies a block.

## Limitations

- The block inventory describes stored container blocks, not source-level
  program semantics. A missing `BDH*` is reported as `absent` only when the
  whole artifact was examined. It is `unknown` when the inspected container
  carries an embedded program tree (`LVzp`) or the file carries other RSRC
  containers that were not inspected, because either could still hold the
  heap. No diagram is reconstructed from compiled code.
- The LabVIEW version is the one recorded by the container's `vers` block. A
  LabVIEW-built executable's outer container typically records none, so the
  field is null there.
- Member VIs stored inside an `.llb` are not listed in this release.
- Malformed or oversized containers fail instead of returning a partial
  inventory. The reader accepts complete artifacts up to 256 MiB. A container
  that exceeds the reader's block, total-section, directory-walk, or
  decoded-byte budgets fails with `resource_constraint` rather than returning a
  partial inventory or a silently truncated scan.
- Reading a file establishes no runtime behavior. The selected program is never
  executed, installed, or modified.
