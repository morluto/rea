# Godot PCK archives

`inspect-artifact` and `extract-artifact` read ordinary Godot PCK formats 1, 2, 3
and 4 without running the game or requiring Godot. Official Godot 4.4.1, 4.6.1
and 4.7.1 produced formats 2, 3 and 4 respectively in verification; other engine
releases have not been verified. Format 1 compatibility follows the
[Godot 3.5 loader](https://github.com/godotengine/godot/blob/3.5/core/io/file_access_pack.cpp#L201-L242)
and [exporter](https://github.com/godotengine/godot/blob/3.5/editor/editor_export.cpp#L1094-L1164)
layout and is covered by synthetic standalone and embedded fixtures; an actual
Godot 3 export has not been exercised.

Format 1 uses an 84-byte header, no pack or member flags, and absolute member
offsets in the complete source file, including an embedded executable carrier.
Its reported flags and file base are zero because those fields are absent.
Zero-offset removal records remain unsupported; REA does not apply patches.

Inspection retains the original header and directory facts, including engine
version, flags, declared file count, source paths, offsets and declared MD5.
For a member declared as `res://scenes/main.gd`, the occurrence's
`source_path` retains that exact declaration while `logical_path` is
`scenes/main.gd`, the relative path used for lookup and extraction.
Observed plaintext bytes receive content-addressed SHA-256 identities. MD5 is a
container integrity claim, separate from the observed SHA-256. A mismatch fails
by default; `--integrity-policy record-and-continue` retains the observed bytes
and an explicit untrusted contradiction. An all-zero MD5 is an unknown claim,
not a verified digest.

Artifact comparison pairs members by `logical_path`, the stored path without
`res://`, and compares their bytes and occurrence facts. It does not compare
`godot-pck-entry` metadata. Godot 4.3
[stores `res://` paths](https://github.com/godotengine/godot/blob/77dcf97d82cbfe4e4615475fa52ca03da645dbd8/editor/export/editor_export_platform.cpp#L228)
and [keys members by them](https://github.com/godotengine/godot/blob/77dcf97d82cbfe4e4615475fa52ca03da645dbd8/core/io/file_access_pack.cpp#L50-L52).
Godot 4.4.1
[stores paths without the prefix](https://github.com/godotengine/godot/blob/49a5bc7b616bd04689a2c89e89bda41f50241464/editor/export/editor_export_platform.cpp#L257-L260)
and [removes it before keying](https://github.com/godotengine/godot/blob/49a5bc7b616bd04689a2c89e89bda41f50241464/core/io/file_access_pack.cpp#L48-L50).
Each version finds `res://scenes/main.gd` in its own export, but comparing the
stored `source_path` would mark every member changed between such exports.
`logical_path` names the member Godot's lookup finds, except in two cases.
REA normalizes Unicode to NFC, so a member renamed only between Unicode forms
compares unchanged, although Godot treats it as another path. Godot reads `\`
as `/` and REA keeps it literal, so a member spelled with backslashes compares
as removed and added. Directory order and offsets are layout. The encryption
bit, the only member flag REA admits, is the occurrence's `encrypted` field. A
member whose encryption changes compares `unknown` in `metadata` and
`availability`: the change is known, but REA does not read encrypted bytes,
so whether the script changed is unknown. Godot's exporter
[stores the MD5 of a member's original bytes](https://github.com/godotengine/godot/blob/a13da4feb8d8aefc283c3763d33a2f170a18d541/editor/export/editor_export_platform.cpp#L465-L468),
as the 4.3 and 4.4.1 exporters do, so the declared MD5 does not depend on the
encryption IV. Encrypted members whose declared MD5s differ therefore also
compare `unknown` in `metadata` and `availability`: the MD5s declare
different scripts, but REA cannot verify them, and equal MD5s add nothing for
the same reason. An encrypted member with an MD5 on only one side stays
`unknown`.

## CLI

Start with a compact summary and keep the complete Evidence bundle:

```sh
rea inspect-artifact /artifacts/game.pck --detail summary \
  --evidence_output /evidence/game.json --json
rea extract-artifact /artifacts/game.pck --json
```

Summary delivery requires `--evidence_output` and never overwrites that file.
The response contains `summary` Evidence and an `evidence_bundle` receipt.
Without `--detail summary`, inspection keeps its complete inline delivery.
Extraction creates a new temporary directory and returns its path. It rejects
unsafe paths and verifies container identity before creating output.

The same CLI commands locate a PCK at the beginning of a file or through its
12-byte EOF trailer in an executable carrier. They do not scan arbitrary
payloads or discover packs behind additional trailing signatures. The root
content SHA-256 covers the whole carrier; its content classification remains
native, while the inventory records the PCK role and exact pack bounds.
An EOF marker is only a candidate: an invalid size or a pointed-to location
without a `GDPC` header leaves native classification in place. Once the
trailer points to a pack header, malformed or unsupported PCK content remains
an error. This recognition boundary follows the Godot loader at pinned source
revision [06d1e7a](https://github.com/godotengine/godot/blob/06d1e7a34ccde4029eed53d018cfde77dfe771d5/core/io/file_access_pack.cpp#L2099-L2146).
Ordinary native `open_binary` detection remains unchanged.

## MCP and selected facts

For a standalone pack, call `open_binary` with its absolute path, then
`inspect_artifact` with `{"detail":"summary"}`. The complete inspection and its
nested inventory stay in the session. Use the summary's
`normalized_result.parent_evidence_id` as the source of subsequent views:

```json
{
  "name": "inspect_analysis_view",
  "arguments": {
    "source": {
      "kind": "retained-evidence",
      "evidence_id": "<parent_evidence_id>"
    },
    "view": {
      "kind": "inventory",
      "collection": "occurrences",
      "logical_paths": ["scripts/main.gd", "project.binary"],
      "fields": [
        "logical_path",
        "declared_integrity",
        "hash_status",
        "format_metadata"
      ],
      "offset": 0,
      "limit": 32
    }
  }
}
```

Occurrences retain `occurrence_id`, `artifact_id` and `parent_occurrence_id`
even when `fields` is empty. Batch occurrence IDs with `occurrence_ids`, or
join returned content IDs to `collection: "nodes"`, `artifact_ids: [...]` and
`fields: ["sha256", "size"]`. Filters intersect; an omitted filter selects all
available rows and an empty array selects none. Pagination follows the filtered
canonical order. Multiple occurrences may share one content ID.

Views reuse authenticated immutable inventory facts and lazy lookup indexes;
they do not reopen the source. These are historical observations, including
after the source changes or disappears. Close the target with `close_binary`
when finished. To read an exported bundle through the CLI, select its complete
inspection record as `source: {kind: "inline", evidence: ...}` in a JSON request
file for `rea inspect-analysis-view request.json --json`.

## Coverage and limits

PCK summaries expose root format metadata, available graph counts,
`available_hash_status_counts`, and `source_coverage`. Inventory pages preserve
producer coverage alongside page coverage. `source_complete` means all declared
retained graph rows are available; it does not establish that an encrypted or
otherwise unknown directory was examined. Missing matches in unknown coverage
are not evidence of absence.

Encrypted directories retain their header and declared file count with unknown
entry coverage. Individually encrypted members retain directory metadata with
unknown content identity; REA does not decrypt them. Sparse bundles likewise
retain header facts with unknown member coverage. Extraction refuses an
unreadable directory or encrypted member. This capability does not recover
keys, decode Godot resources, decompile GDScript bytecode, analyze signals,
apply patch/removal entries or execute targets.

Readable logical member bytes, including repeated physical ranges, share the ZIP
archive expansion policy: at most the larger of 256 MiB or 500 times the PCK's
encoded byte span. Embedded carrier bytes do not enlarge that budget. The full
directory is checked before any member is yielded, hashed or extracted. Encrypted
members are not read and do not consume this plaintext-work allowance. Small
bounded aliases remain valid. This is a processing/output resource bound, separate
from the directory metadata retention budget and format validity.
