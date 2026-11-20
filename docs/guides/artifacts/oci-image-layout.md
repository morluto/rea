# OCI image layouts

`inspect_oci_image_layout` / `inspect-oci-image-layout` reads one selected local
OCI image-layout directory (`oci-layout`, `index.json`, `blobs/<alg>/<hex>`)
and reports layout version, index entries, image config facts, layers, and
streamed digest verification of present referenced blobs. It does not unpack a
tar image layout, decompress layer contents, execute the image, or contact a
registry.

```bash
rea inspect-oci-image-layout /absolute/path/to/busybox.oci --json
```

With `--detail summary --evidence_output /absolute/path/layout.json`, the CLI
saves the complete Evidence as a new bundle and prints a summary view with
layout identity, coverage, and counts of indexes, images, blobs, findings and
limitations.

The CLI resolves relative paths against the caller's working directory. MCP
requires an absolute filesystem path and preserves that exact selection:

```json
{
  "name": "inspect_oci_image_layout",
  "arguments": { "path": "/artifacts/busybox.oci" }
}
```

Directory form only. Tar carriers produced by `docker save` or
`skopeo copy ... oci-archive:` are out of scope; unpack them first and inspect
the resulting directory.

## Observations

The inline Evidence result contains the directory path, a snapshot SHA-256 of
`{layout_version, oci_layout_digest, index_digest}`, the layout version, and
the SHA-256 of `oci-layout` and `index.json`.

`indexes` lists the top-level `index.json` at depth 0 and nested indexes within
`max_index_depth` (default 4, maximum 8). Each entry reports media type, digest,
size, platform (`os`, `architecture`, `variant`, `os_version`) and annotations
such as `org.opencontainers.image.ref.name`.

`images` lists each image manifest: config digest; config `architecture`, `os`,
`variant`, `created`, `author`, `User`; Env names and values (set
`include_env_values` to false to leave the values `null`);
`Entrypoint`, `Cmd`, `WorkingDir`, `ExposedPorts`, `Volumes`, `Labels`,
`StopSignal`; `rootfs.diff_ids`; `history` (`created_by`, `empty_layer`); and
layers (media type, compressed size, digest, whether the blob is present).

`blobs` lists referenced and unreferenced blob files under `blobs/`. Present
referenced blobs are hashed with SHA-256 always, and SHA-512 when the declared
algorithm is SHA-512, streamed under `max_blob_bytes` (default 64 MiB, maximum
512 MiB).

`findings` records missing blobs, digest mismatches, size mismatches,
unreferenced blobs, unknown media types, unsupported digest algorithms, symlink
blobs, nested-index depth exceeded, malformed nested JSON, and blob oversize.
Those conditions do not crash the inventory.

Child symbolic links are not followed. A blob that is a symlink is a
`symlink_blob` finding. Paths that leave the selected root are refused by the
directory admission helpers.

## Limits and failures

Each JSON document (`oci-layout`, `index.json`, manifests, configs) is limited
to 1 MiB by default (16 MiB maximum). Directory enumeration is limited by
`max_entries` to 4096 entries by default (65536 maximum). Decoded index,
manifest and layer descriptors are limited separately by `max_descriptors` to
65536 by default (1048576 maximum); a layer shared by many manifests is one
file but counts once per manifest that references it. Each config blob is read
once, but every image carries its own config facts, so the config bytes behind
each image spend `max_config_bytes` (64 MiB by default, 512 MiB maximum); a
config shared by many manifests counts once per image. Index entries keep
their digests, media types, platforms and annotations in the report, so that
text spends `max_descriptor_bytes` (64 MiB by default, 512 MiB maximum) across
all indexes. Exceeding any of these
budgets refuses the inspect and names the allowance. Nested indexes beyond
`max_index_depth` become findings and are not walked further.

A missing, malformed, or oversize `oci-layout` refuses the inspect. A missing,
malformed, or oversize `index.json` refuses with the `oci-layout` file-snapshot
hash preserved as a partial observation.

This workflow does not decompress or list layer contents. Tar image layouts are
not inspected.

Evidence parameters retain only caller-selected controls; execution resolves
omitted budgets from the documented defaults.
