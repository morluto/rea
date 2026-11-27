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
  data and info ranges. Those offsets are relative to the container; add
  `container.file_offset` — where the container starts in the selected file, 0
  for a direct RSRC file — to map them onto the artifact. A container that
  fails to parse returns no result, so its failure offset is already given in
  the selected file's coordinates;
- the LabVIEW version recorded by the container's `vers` block, decoded from
  the packed four-byte field at the start of that record (two decimal major
  digits, then the minor digit), with `version_coverage` saying whether it was
  `observed`, has no `vers` record (`absent`), or has one that could not be
  decoded (`unknown`). Only those three digits are checked. The stage and build
  bits are not read, because public references disagree on whether the build
  is stored as decimal digits or as a binary count;
- whether a block-diagram heap (`BDH*`) and a front-panel heap (`FPH*`) are
  present, absent from the inspected container, or unknown because content the
  reader did not examine could still hold one;
- every block identifier with its sections: the section index exactly as the
  container declares it (a negative value is preserved, not renumbered), its
  optional name, stored byte count, coding, and the decoded byte count when
  this reader decoded the section.

A LabVIEW-built executable is read through its PE resource directory, under
the `RT_RCDATA` resource type only (other types are skipped before their
entries are read): the
largest embedded RSRC container is inspected and the count of containers found
is reported. The outer container of a built executable usually holds a `FLAG`
block and one `LVzp` block (the embedded program tree) rather than the per-VI
blocks a source `.vi` carries.

## Delivery

`detail: "complete"` returns the whole block inventory inline. With
`detail: "summary"`, or with `detail` omitted when the complete result would
exceed the agent result budget, the reply carries the container, version and
heap facts with block and section counts. The complete inventory stays in
retained Evidence. Page it with `inspect_analysis_view` kind
`labview-artifact`, collection `blocks` or `sections` (optionally filtered to one
four-character `block`), or read it whole with kind `evidence-json`. The CLI
takes `--detail` and `--evidence_output` the same way.

## Coding and decoding

A section is reported with one coding:

| Coding    | Meaning                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `none`    | Stored bytes are the section content                                                                                                                         |
| `zlib`    | A four-byte big-endian length followed by a zlib stream                                                                                                      |
| `xor`     | A LabVIEW XOR-coded block, such as the embedded program tree (`LVzp`)                                                                                        |
| `unknown` | A zlib section that did not decode to its declared length, declares a preset dictionary (FDICT), or was not attempted because a decode allowance was reached |

Only zlib-coded sections are decoded, and only to establish their decoded byte
count. No section payload is returned; use another tool to extract content once
the inventory identifies a block.

## Limitations

- The block inventory describes stored container blocks, not source-level
  program semantics. A missing `BDH*` is reported as `absent` only when the
  whole artifact was examined. It is `unknown` when the inspected container
  carries an embedded program tree (`LVzp`), the file carries other RSRC
  containers that were not inspected, the selected file is a direct RSRC
  container whose content does not establish whether it is a VI, a control, or
  an `.llb` archive whose member VIs were not opened, or a PE resource branch
  could not be read, because any of them could still hold the heap. The file
  name is not evidence of format. No diagram is reconstructed from compiled
  code.
- The LabVIEW version is the one recorded by the container's `vers` block. A
  LabVIEW-built executable's outer container typically records none, so the
  field is null there.
- Member VIs stored inside an `.llb` are not listed in this release.
- Malformed or oversized containers fail instead of returning a partial
  inventory. The reader accepts complete artifacts up to 256 MiB. A container
  that exceeds the block, total-section, or directory-walk allowance fails with
  `resource_constraint` rather than returning a partial inventory or a silently
  truncated scan. A section whose decode would exceed the container's fixed
  64 MiB compressed-input or 64 MiB decoded-output allowance is reported with
  coding `unknown` and is not decoded, and a limitation names the allowance
  that stopped it (this release has no override). The inventory continues.
  A PE whose RCDATA resource branch could not be read is refused with that
  reason rather than reported as carrying no embedded container.
- Reading a file establishes no runtime behavior. The selected program is never
  executed, installed, or modified.
