# Windows Shell Link shortcuts

`inspect_windows_shortcut` / `inspect-windows-shortcut` answers whether one
selected local file is a Windows Shell Link (`.lnk`), which target path,
arguments, working directory, and icon location it records, which volume and
network names `LinkInfo` stores, and which ExtraData blocks follow the
strings. It reads the file without resolving or executing the target and does
not require a Windows SDK, COM, or a network.

```bash
rea inspect-windows-shortcut /absolute/path/to/shortcut.lnk --json
```

The CLI resolves relative paths against the caller's working directory. MCP
and the advertised input schema require an absolute filesystem path and
preserve that exact selection:

```json
{
  "name": "inspect_windows_shortcut",
  "arguments": { "path": "/artifacts/shortcut.lnk" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte
length. `header` is the 76-byte `ShellLinkHeader`: `LinkFlags` and
`FileAttributes` as raw values plus documented names, creation/access/write
FILETIMEs as a raw 64-bit decimal and ISO-8601 UTC when the timestamp is in
range, file size, icon index, `ShowCommand` (`normal`, `maximized`, or
`minimized`), and hotkey modifiers. Undocumented `ShowCommand` values are
decoded as `normal`, as specified.

`id_list` is present when `HasLinkTargetIDList` is set. Each item keeps its
file offset, size, and type byte. Root-folder, volume, and file-entry items
are decoded when those layouts match documented shell-item headers, including
the 8.3 short name on a file entry. Every other item is `raw` with a SHA-256
of its payload. Unknown items are not guessed.

`link_info` reports volume drive type, serial, label, local base path, and
common network relative link names, with Unicode variants when the header
declares them. ANSI strings use a byte-preserving Latin1 projection; the
original system ANSI code page is unobserved.

`string_data` reports name, relative path, working directory, command-line
arguments, and icon location according to `LinkFlags`, each with encoding,
`CountCharacters`, byte length, and the decoded value. `IsUnicode` selects
UTF-16LE; otherwise the Latin1 projection is used.

`extra_data` enumerates every block: signature, size, and offset.
`EnvironmentVariableDataBlock` and `IconEnvironmentDataBlock` expose ANSI and
Unicode targets. `TrackerDataBlock` exposes the NetBIOS machine id and droid /
birth-droid GUIDs. Version-1 UUID MAC and timestamp values are labelled
`evidence_kind: "derived"`. `KnownFolderDataBlock` and `SpecialFolderDataBlock`
keep their folder identifiers. `ConsoleFEDataBlock` keeps the code page.
`PropertyStoreDataBlock` and unrecognized signatures stay raw with SHA-256.
Unknown signatures are listed and are not dropped.

`observations` are derived only from those documented fields: whether
arguments are present, argument character length, target extension, whether
`ShowCommand` is minimized, and whether the icon location differs from the
recorded target path. This workflow does not emit verdicts about intent.

A missing optional section is observed absence of that structure. It is not
proof the shortcut never carried that data in another container.

## Limits and failures

The selected file is limited to 1 MiB by default (16 MiB maximum). At most 256
IDList items (4096 maximum) and 64 ExtraData blocks (1024 maximum) are
examined by default. Retained string payload bytes across StringData,
LinkInfo, and ExtraData are limited to 64 KiB by default (1 MiB maximum).
Malformed `HeaderSize` or `LinkCLSID`, and exhausted budgets, fail without
partial success. Truncation after a valid header, ExtraData size overruns, and
odd Unicode lengths return partial coverage with `coverage.failing_offset`.
Coverage is never `complete` when issues are present.

The selected path must be a regular file. Symbolic links are rejected.
UNC paths and other host-prefixed device paths, such as `\\server\share\a.lnk`
and `\\?\UNC\server\share\a.lnk`, are rejected before any filesystem call. A
mapped network drive cannot be told apart from a local drive by its path and is
not rejected.
This workflow does not resolve, open, or execute the link target or call COM,
and it does not contact a network for a path on a local volume.
