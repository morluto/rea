# Unity Addressables catalogs

`inspect_unity_addressables` / `inspect-unity-addressables` reads one selected
local Unity Addressables content catalog and returns its keys, resource
locations, provider records and catalog identity. It reads the file without
running it and requires no Unity installation, asset bundle or network access.

Supported catalogs:

| Catalog                        | Written by                                              | Notes                                                                                 |
| ------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `catalog.json`                 | Addressables 1.x, and 2.x with the JSON catalog setting | Base64 key, bucket, entry and extra data; prefix-compressed internal ids are expanded |
| `catalog.bin` header version 2 | Addressables 2.x                                        | BinaryStorageBuffer layout                                                            |
| `catalog.bin` header version 3 | Addressables 4.x                                        | Same location layout as version 2                                                     |

Binary header version 1 (the optional `ENABLE_BINARY_CATALOG` define in
Addressables 1.21 and 1.22) is refused as unsupported. The decoder is chosen
from file content, not the file name.

Each location reports its primary key, internal id (a bundle path such as
`{UnityEngine.AddressableAssets.Addressables.RuntimePath}/StandaloneOSX/core_assets_all_<hash>.bundle`
or an asset path), provider id, resource type, dependencies as location indices
and, for asset bundles, the recorded Hash128, CRC, bundle name and size. Keys
report their encoding (`string`, `int32`, `uint32`, `uint16`, `hash128`,
`type` or `object`) and the locations they select.

With `hash_path`, the tool also records the text of a caller-selected
`catalog.hash` file. The hash is reported as written; it is not recomputed or
compared with the catalog bytes.

## MCP

MCP defaults to a compact summary and retains the complete decoded Evidence in
the session:

```json
{
  "name": "inspect_unity_addressables",
  "arguments": {
    "path": "/artifacts/Game_Data/StreamingAssets/aa/catalog.bin"
  }
}
```

The summary returns catalog identity and `counts` (`providers`, `keys`,
`locations`, `bundles`, `dependency_edges`). Page rows through the retained
Evidence without reopening the file:

```json
{
  "source": {
    "kind": "retained-evidence",
    "evidence_id": "<parent_evidence_id>"
  },
  "view": {
    "kind": "unity-addressables",
    "collection": "locations",
    "data_kinds": ["asset-bundle"],
    "fields": ["internal_id", "data"],
    "offset": 0,
    "limit": 64
  }
}
```

Collections are `keys`, `locations` and `providers`. Keys accept `values` and
`kinds`. Locations accept `key_indices` (locations a key selects),
`primary_keys`, `provider_ids`, `internal_ids` and `data_kinds`
(`asset-bundle`, `other`, `none`). Filters intersect; `indices`, `fields`,
`offset` and `limit` work on every collection, and each row keeps its source
`index`.

## CLI

```bash
rea inspect-unity-addressables /absolute/path/catalog.json --hash /absolute/path/catalog.hash --json
```

The CLI returns complete Evidence by default;
`--detail summary --evidence_output FILE` writes the full result to a new file
and prints a compact overview.

## Confidence and limits

- Keys, locations, provider ids, resource types and bundle hash, CRC, name and
  size are observed catalog content. JSON dependencies are derived the way the
  runtime locator resolves them, through the entry's dependency key, so JSON
  Evidence is labeled derived. Binary dependencies are stored location records.
- `dependency_hash` is the stored field. Binary catalogs store it, but the
  runtime computes its own value from the dependency array offset.
- Internal id placeholders such as `{UnityEngine.AddressableAssets.Addressables.RuntimePath}`
  are not resolved. Runtime overrides (`InternalIdTransformFunc`, remote
  catalog updates) are unknown.
- No asset bundle is opened, so bundle contents and whether the recorded CRC
  matches a bundle file are not checked.
- Binary locations are numbered in first-reference order: locations selected by
  keys first, then records named only by dependency sets. There is no reverse
  index from a bundle to the locations that depend on it; page `locations` and
  invert `dependencies`.
- Location data other than asset bundle request options reports its type name
  only. A binary object key or location data whose type record stores no class
  name reports `type_name: null` (unknown), not an empty name.
- Input is limited to 256 MiB per catalog and 4 KiB per hash file; the encoded
  report to 64 MiB; one inspection runs at a time per reader. Unsupported
  formats, malformed records and resource limits return typed reasons.

## Checked builds

Contributor-reported verification: catalogs built with Unity 2022.3.62f3 and
Addressables 1.22.3 (JSON, local and remote), and Unity 6000.4.1f1 with
Addressables 2.10.3 (binary version 2) and 4.1.1 (binary version 3), decoded
to the same keys, locations, dependencies and bundle options that the
package's own catalog loader produced in the same editor. Other Addressables
releases have not been checked.
