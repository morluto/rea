# Compound File Binary container inspection

This specification records an implementation increment and its original problem
statement. For current behavior and limitations, see the artifact inventory
guide.

## Problem and outcome

REA has no reader for OLE Compound File Binary (CFB) containers. Windows
artifacts such as Jump Lists (`*.automaticDestinations-ms`,
`*.customDestinations-ms`), Thumbs.db and many installers are CFB files, so an
analyst holding one could only treat it as an opaque blob. Add offline,
read-only inventory of a selected container, delivered in steps so each one
merges on its own.

## Requirements

- Recognize a container by the compound file signature at offset 0, under any
  file name, and route it to a dedicated artifact reader.
- Validate the header: the byte-order mark, the major version, and the sector
  shift each version requires.
- Read the allocation tables the DIFAT declares, including the DIFAT chain, and
  report declared-versus-found counts when they disagree.
- Walk the directory stream and list every entry's declared name, type,
  parent, tree links, starting sector and stream size.
- Verify each FAT-backed stream's allocation chain: it must stay inside the
  declared file, must not revisit a sector, and must reach the declared size.
  A broken chain is reported per entry and counted in the metadata.
- Classify each entry's bytes as FAT-backed, mini-stream-backed or empty, and
  report contiguity so a caller knows whether a single byte range exists.
- Report entries that are unreachable from the root storage as orphans with no
  path, links that leave the entry table, and tree links that cycle.
- Bound the whole file at a fixed 512 MiB ceiling and report the ceiling as a
  `limit` failure with its boundary.
- Interpret no stream's contents in this step. DestList records, shell link
  targets and thumbnail bytes stay opaque.

## Acceptance

Synthesized fixtures cover a storage tree with nested streams, a mini stream, a
chain that revisits a sector, a chain shorter than the declared size, an
unreachable orphan entry, a tree link outside the entry table, a repeating tree
link, a signature-less file, a wrong version, a mismatched sector shift, a
wrong byte order, a directory chain outside the file, and the file-size
ceiling. Reader tests cover the root occurrence's metadata and path listing,
the orphan limitation, the broken-chain limitation, and refusal of an
undefined version.

Not covered in this step: real Jump List, Thumbs.db or installer captures,
mini FAT chaining, stream content of any kind, and any artifact-specific
interpretation.
