# PE Rich header records

## Problem and outcome

REA has no reader for the Rich header. Microsoft's linker writes this record
between the DOS stub and the PE signature. It lists the compiler, assembler,
linker and import-library builds that produced an image, and how many objects
each contributed. Analysts use it to identify a Windows toolchain, or to notice
a record copied or edited after linking, when the image has no DWARF. Add one
read-only inspection that reports the record without running the image.

## Requirements

- `inspect_pe_rich_header` (MCP) and `rea inspect-pe-rich-header` (CLI) read
  one explicit local PE32 or PE32+ file through the stable artifact reader. MCP
  paths are absolute.
- `rich_header.state` is `present`, `malformed` or `absent`.
- Find the record from the last DWORD-aligned `Rich` footer whose key ends at or
  before the PE signature. Then walk back to the nearest `DanS` encoded with
  that key. Do not assume `DanS` at `0x80`, and do not take the first footer.
- A present record reports its file range, footer range, key, decoded padding,
  and each entry's product ID, build and use count.
- Recompute the linker checksum and report whether it reproduces the stored key.
- A footer with no matching `DanS` is `malformed` with `start_marker_missing`.
  A record that ends inside an entry is `malformed` with `partial_entry`.
- No footer before the PE signature is `absent`. Its limitation says absence
  does not show how the image was built. A PE header inside the 64-byte DOS
  header is `absent` too.
- A DOS MZ image with no PE header is `unsupported_target`.
- `max_file_bytes` (default 64 MiB, ceiling 512 MiB) and `max_entries` (default
  1024, ceiling 65536) bound the work. Exceeding either fails without partial
  success. Long scans yield and observe cancellation.
- Once the read completes, a later failure keeps the file path, SHA-256 and byte
  count as a partial observation.
- CLI numeric options accept decimal integers only.

## Acceptance

Parser tests on synthetic PE32 and PE32+ images compare the key with an
independent checksum. They cover zero entries, nonzero padding, an edited stub,
a wrong key, an overlapping footer, unaligned markers, an earlier footer in the
stub, malformed records, the entry budget, cancellation and non-PE input.
Service, provider, CLI, MCP and filesystem tests cover the public contract and
its failures. `scripts/verify-pe-rich-header.mjs` compares key and entries with
pefile on real images and fails on any unexplained difference.

## Out of scope

Names for product IDs or Visual Studio releases, the "rich hash", editing or
removing the record, and any execution of the image.
