# ELF debug files

`inspect_elf_debug_link` / `inspect-elf-debug-link` answers which separate
debug file one selected local ELF32/ELF64 image names, which GNU build-id that
image carries, and whether one caller-selected file matches that linkage. It
reads the selected files without executing them and does not search the
filesystem or the network.

```bash
rea inspect-elf-debug-link /absolute/path/to/program --json
rea inspect-elf-debug-link /absolute/path/to/program --candidate-path /absolute/path/to/program.debug --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires absolute filesystem paths and preserves those exact selections:

```json
{
  "name": "inspect_elf_debug_link",
  "arguments": {
    "path": "/artifacts/program",
    "candidate_path": "/artifacts/program.debug"
  }
}
```

Omit `candidate_path` when the question is only which debug file the image
names. Supply it only for a file you already chose. The tool does not open the
lookup path strings it returns.

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte
length. `debuglink` reports the `.gnu_debuglink` file name and CRC32.
`debugaltlink` reports the `.gnu_debugaltlink` file name and the build-id
bytes that follow it. `build_id` reports the GNU build-id from `PT_NOTE` and
`SHT_NOTE` tables. The same build-id from both tables is one observation.
Distinct build-ids stay in `ids` and none is selected.
`sources` lists each contributing GNU build-id note with its table kind and
index and the note and descriptor file ranges.

`lookup_paths` lists conventional GNU/Linux strings:

- `/usr/lib/debug/.build-id/xx/rest.debug` from the image GNU build-id
- `<directory>/.debug/<name>` from the debuglink file name
- `/usr/lib/debug/<directory>/<name>` from that same name
- the same build-id directory shape for a `.gnu_debugaltlink` build-id, with
  kind `alt_build_id`

`<directory>` is the directory portion of the caller-supplied image path.
A Windows image path such as `C:\dir\prog` keeps its own separator for the
`.debug` string (`C:\dir\.debug\<name>`), and the global string keeps the
drive letter as a directory (`/usr/lib/debug/C/dir/<name>`), as GDB does.
These strings are not opened. A same-directory `<directory>/<name>` string is
not included. A debuglink name that is empty, `.`, `..`, or contains a slash
or backslash does not produce the two directory strings. File names and lookup
paths are untrusted data. Their text is a byte-preserving Latin1 projection.

`debugdata` reports whether `.gnu_debugdata` is present, its file offset, and
its stored size. The first six bytes are compared with the xz magic
`fd 37 7a 58 5a 00`. The xz payload is not decoded.

With `candidate_path`, `verification.status` is `matches`, `does_not_match`,
or `cannot_verify`. The CRC32 check covers the whole candidate file. The
build-id check compares the image GNU build-id with the candidate GNU
build-id. The `.gnu_debugaltlink` build-id is not that comparison. A mismatch
on either check is `does_not_match`. A match on either check, with no
mismatch, is `matches`. If neither check can run, the status is
`cannot_verify`. `candidate.debug_info` and `candidate.symtab` say whether
those sections are present, so the result shows what the file would add.

The candidate is streamed in bounded chunks, so its size is not limited by
`max_file_bytes`. A candidate within `max_file_bytes` is also decoded for its
sections and GNU build-id. A larger candidate is still checked by CRC32 and
SHA-256 over the whole file, but only its ELF header is decoded: its sections
are `unknown` and the build-id check is `unavailable`. A candidate that is
missing, unreadable, changed while it was read, or 4 GiB or larger returns
`cannot_verify` with reason `candidate_unreadable` and `candidate: null`; the
image linkage is still reported. A candidate is decoded with the same
`max_entries` and ELF decoding budgets as the image. When it exceeds one, the
image linkage is still reported, the build-id check is `unavailable` with
reason `candidate_build_id_unknown`, sections that were not decoded are
`unknown`, and the CRC32 check still runs. A symlinked or non-regular
candidate is rejected as invalid input.

A missing named section is observed absence only when section names are
complete. When names are incomplete, a missing section is `unknown`. A
malformed or truncated section is `malformed`, not absence. GNU build-id
absence means the declared note tables had no build-id. It is not proof the
image never carried one.

The section layouts follow the separate debug file description in the GDB
manual: <https://sourceware.org/gdb/current/onlinedocs/gdb.html/Separate-Debug-Files.html>.
`.gnu_debuglink` is a NUL-terminated name, padded to a 4-byte boundary, then a
CRC32 in the image endianness. `.gnu_debugaltlink` is a NUL-terminated name
followed by raw build-id bytes.

## Limits and failures

The image is limited to 64 MiB by default (512 MiB maximum). The same
`max_file_bytes` bounds how much of a candidate is decoded, not how much is
hashed. At most
32 note entries are examined by default while reading build-ids. A debuglink
or debugaltlink name longer than 4096 bytes is not copied. A build-id longer
than 256 bytes is not copied. Malformed image ELF headers and exhausted image
note budgets fail without partial success. Whole-file gzip, xz, and zstd
containers are not ELF images and fail as invalid input.

This workflow does not execute the image, search for debug files, or use the
network. It does not decode the `.gnu_debugdata` xz payload.
