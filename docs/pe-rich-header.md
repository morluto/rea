# PE Rich header

Use `inspect_pe_rich_header` to read the Rich header of an explicit local PE32
or PE32+ image. Microsoft's linker writes this record between the DOS stub and
the PE signature. It counts the objects each compiler, assembler, linker and
import-library tool contributed, by product ID and build number. No
disassembler, Windows host, Visual Studio or target execution is required.

```sh
rea inspect-pe-rich-header /absolute/path/to/application.exe --json
rea inspect-pe-rich-header /absolute/path/to/application.exe --max-entries 4096 --json
```

MCP accepts `{ "path": "/absolute/path/to/application.exe" }`. CLI paths may be
relative to the current directory; MCP paths must be absolute.

## Report

`pe_header_offset` is `e_lfanew`, which ends the search. `rich_header.state` is
one of:

- `present`: the record decoded. `location` runs from `DanS` through the key
  after `Rich`, and `footer_location` covers `Rich` and the key. Each entry in
  `entries` is one `@comp.id`: `product_id` is its high word, `build` its low
  word, and `count` its use count. `padding` holds the three DWORDs after
  `DanS`, decoded with the key. Microsoft's linker writes zeros there.
- `malformed`: a `Rich` footer exists, but the record does not decode. `reason`
  is `start_marker_missing` when no `DanS` encoded with that key precedes the
  footer, or `partial_entry` when the record ends inside an entry.
- `absent`: no `Rich` footer precedes the PE signature. Other linkers omit the
  record, and it can be stripped after linking, so absence does not show how
  the image was built. A PE header that starts inside the 64-byte DOS header
  leaves no room for a record, so it is `absent` too.

Evidence locations include the record's file range, or only the footer for a
malformed record.

## How the record is found

REA takes the last DWORD-aligned `Rich` marker whose key ends at or before the
PE signature. It then walks back one DWORD at a time to the nearest `DanS`
encoded with that key.

The last marker matters. A custom DOS stub can hold a whole image with its own
Rich header. On one Windows 11 host, `C:\Windows\System32\tcblaunch.exe` has a
footer at `0xE8` inside its stub and the image's own record at `0x2D20`.
`DanS` is not always at `0x80` either: drivers on the same host place it at
`0x58` and `0x200`.

## Checksum

The key is a checksum. REA recomputes it:

1. Start with the file offset of `DanS`.
2. Add every byte before `DanS`, rotated left by its offset modulo 32. Skip
   `e_lfanew` at offsets `0x3C` to `0x3F`.
3. Add every `@comp.id`, rotated left by its count modulo 32.
4. Keep the low 32 bits.

`checksum.matches` reports whether that reproduces the stored key. A mismatch
means the DOS header, the stub or the entries differ from what was summed, for
example a record copied from another image or a stub edited after linking. It
does not show which bytes changed. A match says nothing about the rest of the
image.

## Limits

Product IDs and builds are reported as stored. REA does not name the tool or
Visual Studio release behind them.

Only PE32 and PE32+ images are read. A DOS MZ executable with no PE header is
an unsupported target, not `absent`.

The default read budget is 64 MiB (`max_file_bytes`, ceiling 512 MiB). The
default entry budget is 1024 (`max_entries`, ceiling 65536). Exceeding either
fails without partial success, as does a malformed PE header.

## Verification

`npm run verify:pe:rich-header -- PATH...` inspects each PE file under the given
files and directories, then compares key and entries with pefile's
`parse_rich_header` wherever pefile's layout assumption holds. Any other state
difference fails the run, as does a file only REA rejects or a run that
compares no file. Set
`REA_PEFILE_PYTHON` to a Python that imports pefile 2024.8.26. See the
[2026-11-04 verification record](verification/pe-rich-header-2026-11-04.md).

The [feature specification](specs/native/pe-rich-header/spec.md) records the
requirements, with its [plan](specs/native/pe-rich-header/plan.md) and
[tasks](specs/native/pe-rich-header/tasks.md).
