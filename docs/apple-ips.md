# Apple IPS crash reports

`inspect_apple_ips` / `inspect-apple-ips` answers whether one selected local
Apple `.ips` file is a crash report (`bug_type` string `"309"`), which process,
exception, and termination facts that report records, which threads and
`usedImages` rows it lists, and which documented crash classes its strings
match. It reads the file without executing a target and does not require Xcode,
atos, a disassembler, or pwntools.

```bash
rea inspect-apple-ips /absolute/path/to/report.ips --json
```

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_apple_ips",
  "arguments": { "path": "/artifacts/report.ips" }
}
```

## Observations

The inline Evidence result contains the artifact path, SHA-256, and byte length.
`metadata` is the first-line JSON object. `bug_type` stays a string. The crash
body is parsed only when that string is `"309"`. Other types, including `"288"`
stackshots, return no crash result.

`process`, `exception`, `termination`, `faulting_thread`, `threads`, and
`images` reproduce documented body fields when present, including each image's
`name` and each frame's `symbolLocation` (as `symbol_location`, the byte offset
from the start of `recorded_symbol`). `termination` keeps the terminating
process as `by_proc` and `by_pid` and its `flags`; `process.parent_pid` keeps
`parentPid` next to `parent`; and `metadata` keeps `build_version` and
`platform`. Integers keep their
decimal literals and a hexadecimal form, including arm64e registers above
2^53. Frame roles follow the recorded frame index: row zero of the resolved
faulting thread is `faulting_instruction`, row zero of other threads is
`current_instruction`, and later rows are `return_address`. Each runtime
address uses that row's own image base and offset. The recorded `inline` flag
does not supply a missing offset or authorize borrowing another row's address.
When `faultingThread` is missing or does not resolve to a recorded thread
object, row-zero roles are `unknown`; the recorded lookup remains available.
A translated process records Rosetta's registers in a nested
`threadState.rosetta` object; each one is reported as `rosetta.<name>` and
counts toward the register budget. A [public ReportCrash `.ips` log](https://github.com/Mortennn/Dozer/issues/189)
shows `rosetta.tmp2`, `tmp1`, and `tmp0` beside ordinary x86 registers. The
test fixture quotes that register excerpt inside an authored report body; it
does not generate a new Rosetta crash during the test.
Observed JSON strings retain `""`; `null` means the field was missing or JSON
`null`. This includes image paths, frame symbols, process text, and the older
string `osVersion` form. Unlisted JSON keys and generic register names also
retain empty spellings. An empty image architecture remains recorded as `""`
while `uuid_unknown` stays true, since that spelling does not establish an
architecture. An empty UUID is malformed, so its exact spelling appears in
`coverage.type_mismatches` and its canonical UUID remains unknown.
`process.os_version` keeps the producer's dictionary (`train`, `build`,
`release_type`, `is_embedded`) or the older string form. Image UUIDs are uppercase 8-4-4-4-12; an all-zero UUID
or a missing or empty `arch` is `uuid_unknown`. Image `source` letters keep their
documented meaning (`P` process, `S` shared cache, `C` shared cache library,
`K` kernel, `U` kernel cache, `T` kernel text exec, `A` absolute). Keys the
documentation does not list remain in `unlisted_keys` or `unlisted_body_keys`.

Each frame's `image_index` refers to its entry in `images`. Image architecture,
UUID and `uuid_unknown` are retained once on that image. Resolve the reference
when using those facts; an absent or out-of-range index leaves the image
unknown. This avoids repeating image text for every stack frame.

A present value whose JSON type differs from the documented one is never read
as absent: it is listed in `coverage.type_mismatches` with its path, the
expected type, and the observed type, and `coverage.status` becomes
`partial`. A crash body without `threads` or `usedImages` is also `partial`.
Malformed image UUID strings likewise make coverage partial; their exact spelling
is retained in the mismatch's `recorded_value`, while the canonical image UUID
remains unknown. Both 32 hexadecimal digits and canonical hyphenated UUIDs are accepted.
Unresolved thread/image references also make coverage partial. A rejected
integer lookup keeps its exact decimal literal in `recorded_integer`, including
negative values and values above uint32. Valid uint32 lookup values remain in
`faulting_thread` or `image_index` even when the referenced row is unavailable.

`classification` matches only documented SIGKILL codes (compared by their
canonical hexadecimal form), `EXC_GUARD` subtypes,
pointer-authentication suffixes, and dyld missing-library strings. A report
that matches none of those rules is `unclassified`.

## Joining frames to the crashed Mach-O or dSYM

Pass `join_path` (`--join-path` in the CLI) to select one local Mach-O
executable or dSYM. UUID bytes in the report and the artifact's `LC_UUID` load
commands are compared in hexadecimal, so an uppercase `dwarfdump --uuid` value
and a lowercase report `uuid` match.

```bash
rea inspect-apple-ips /absolute/path/to/report.ips \
  --join-path /absolute/path/to/App.app/Contents/MacOS/App --json
```

Shared-cache image sources `S` and `C` remain unjoined: UUID agreement does not
establish that a standalone image has the cached layout.

For a FAT container every slice is examined. An image joins only when exactly
one slice has that UUID **and** an architecture that agrees with the report's
`arch`; `arm64` and `arm64e` stay distinct, and an all-zero UUID never joins. A
UUID match with a different architecture, more than one compatible slice, or a
slice without a readable `__TEXT` segment is reported as a rejected image with
its reason and stays unjoined rather than being guessed.
An unknown UUID in another slice prevents a unique join unless its architecture
rules out a match. Missing or unrecognized architecture and unsupported CPU
subtypes remain unknown; display-name fallbacks do not establish agreement.
The parsed slice facts remain available even when no match can be derived.

`join.status` is `selected` with the artifact path, SHA-256, byte length, every
slice's offset, arch, CPU type and subtype, UUID, and `__TEXT` vmaddr, plus
`image_matches`, per-frame results, and join-specific limitations. A joined
frame reports `static_address`, the slice `__TEXT` vmaddr plus the frame's
recorded `imageOffset`, in decimal and hexadecimal. An unjoined frame reports
a reason instead; an unknown image UUID, an absent `imageIndex` row, and a
frame without `imageOffset` all stay unjoined rather than treated as aligned.

An artifact that is not a Mach-O image or FAT container reports
`join.status: "unreadable"` with a typed reason and leaves every report fact
intact. Symbol names printed inside the report stay recorded claims. Function
or symbol lookup at a joined static address, and matching dSYM symbol tables,
are not performed by this step.

Symbol names printed inside the report are recorded claims and are not
verified. Linux ELF cores use the separate
[recorded crash](guides/native/recorded-crashes.md) workflow.

## Limits and failures

The selected file is limited to 1 MiB by default (16 MiB maximum). At most 256
threads, 8192 frames, 1024 `usedImages` rows, and 16384 `threadState`
register slots are examined by default (4096 / 65536 / 4096 / 262144
maximum). Budgets are checked before each row is parsed, and body members the
report does not interpret are syntax-checked without being kept. Fixed
allowances bound JSON nesting (64 levels), unlisted key names per object
(1024), and `termination.reasons` entries (256). Malformed metadata, a
truncated crash body, invalid UTF-8, a NUL in the text, and exhausted budgets
fail without partial success.

`max_integer_text_bytes` (`--max-integer-text-bytes` in the CLI) separately
bounds retained decimal and hexadecimal integer text, including every derived
runtime address and rejected lookup literal. Its default is 8 MiB of UTF-16 text storage and its maximum is
64 MiB. Each appearance counts, even when an object could be shared in memory
but would be serialized more than once. The parser reserves a conservative
upper bound before numeric conversion or address expansion, then releases the
unused reservation after each value. It reuses the parsed source integer when
the same image base contributes to many frames.

Raise this per-call allowance on the next call when more room is needed; no
restart is required. File-size and row budgets do not raise it. This allowance
is separate from JSON wire size, MCP response limits and the client's receive
buffer. An exhausted allowance reports a typed resource error without partial
success or truncated integer facts.

```bash
rea inspect-apple-ips /absolute/path/to/report.ips --max-integer-text-bytes 16777216 --json
```

`max_join_bytes` (`--max-join-bytes`) independently bounds the join artifact
read, defaulting to 64 MiB. This workflow does not execute a target, launch
atos, or search for dSYMs.

## Join admission and failures

The join uses the shared Mach-O container, slice, command-table and segment
readers. Slice extents and `sizeofcmds` bound every identity observation; duplicate
UUIDs or malformed commands cannot select the first plausible value. Unreadable
join results retain the successfully read artifact's path, SHA-256 and byte count.

The integer-text allowance spans the report and join, including repeated integer
facts and derived static addresses. Reservation precedes derived address
expansion. If a selected join read, interpretation or allowance fails, the error
retains the completed IPS report. Join read limits and recovery use
`max_join_bytes`, even when the report and join paths are identical. Cancellation
retains the caller's reason independently of those completed facts.

When a failure follows a completed join-file read, `partial_observation` retains
both the decoded report and a `join_artifact` receipt with the independently
observed path, SHA-256 and byte count. Frame rejection reasons reference
`join.limitations`; source-sized architecture diagnostics are retained once per
image rather than copied into every frame. Universal-image admission includes
the shared reader's supported hidden ARM64 row and rejects overlapping slices.
