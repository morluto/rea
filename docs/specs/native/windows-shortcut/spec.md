# Windows Shell Link shortcut inspection

## Problem and outcome

REA has no Shell Link reader. An analyst holding a local `.lnk` file cannot ask
which target, arguments, working directory, icon location, volume or network
names, and ExtraData blocks it records without resolving the target, calling
COM or using a Windows host. Add one static inspector that reads a selected
local file and returns those facts as inline Evidence.

## Requirements

- Add `inspect_windows_shortcut` (MCP) and `inspect-windows-shortcut` (CLI).
  MCP requires an absolute path; the CLI resolves a relative path against the
  caller's working directory.
- Accept only a regular file. Reject symbolic links, UNC and other
  host-prefixed device paths before any filesystem call, and on Windows a path
  whose parent is a symbolic link or junction.
- Validate the 76-byte `ShellLinkHeader` (`HeaderSize` `0x4C` and the Shell
  Link CLSID) and decode `LinkFlags`, `FileAttributes`, FILETIMEs, file size,
  icon index, `ShowCommand` and hotkey.
- Decode `LinkTargetIDList` items whose layouts match documented shell-item
  headers; keep every other item raw with a SHA-256 of its payload.
- Decode `LinkInfo` volume and network names, `StringData` per `LinkFlags`, and
  enumerate every ExtraData block. Unknown signatures stay raw with SHA-256.
  Tracker version-1 MAC and timestamp values are labelled derived.
- Emit only documented-field observations: argument presence and length,
  target extension, minimized `ShowCommand`, and whether the icon location
  differs from a recorded full target path (`null` when not comparable).
- Bound file size, IDList items, ExtraData blocks and retained string bytes,
  with caller-adjustable limits and documented maximums. Honor cancellation.
- Never open, resolve or execute the link target, call COM or contact a network
  for a local-volume path.

## Acceptance

Synthesized fixtures cover a hidden-window PowerShell shortcut with an icon
mismatch, network-share `LinkInfo`, Tracker version 1, ANSI strings, truncated
`StringData`, an unknown ExtraData signature and a wrong CLSID. Malformed
headers and exhausted budgets fail without partial success; truncation after a
valid header returns partial coverage with `coverage.failing_offset`, and
coverage is never `complete` when issues are present. CLI and stdio MCP
acceptance, MCP advertisement, filesystem symlink, budget and cancellation
boundaries, stable-artifact consumers and native acquisition finalization are
covered.

## Out of scope

Resolving or launching the target, COM `IShellLink` calls, Windows SDK use,
recovering the original system ANSI code page, verdicts about intent, and
routing `.lnk` files through `inspect_artifact`.
