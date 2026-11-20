# OCI image-layout inspection

## Problem and outcome

Analysts receive OCI image layouts as evidence directories (`oci-layout`,
`index.json`, `blobs/<alg>/<hex>`) and today walk the JSON by hand. Let
`inspect_oci_image_layout` / `inspect-oci-image-layout` inventory one selected
local directory without unpacking a tar, decompressing layers, executing the
image, or contacting a registry.

## Requirements

- Report layout version, snapshot identity, and the SHA-256 of `oci-layout` and
  `index.json`.
- List every index entry (media type, digest, size, platform, annotations such
  as `org.opencontainers.image.ref.name`) and nested indexes within a bounded
  depth (default 4, maximum 8).
- For each image manifest, report config digest and config `architecture` /
  `os` / `variant`, `created`, `author`, `config.User`, Env (names and
  values; `include_env_values: false` keeps names only), `Entrypoint`, `Cmd`,
  `WorkingDir`, `ExposedPorts`, `Volumes`, `Labels`, `StopSignal`,
  `rootfs.diff_ids`, and `history` (`created_by`, `empty_layer`).
- List layers (media type, compressed size, digest, whether the blob is
  present).
- Stream SHA-256 of every present referenced blob, and SHA-512 when the
  declared algorithm is SHA-512, under a byte budget.
- Record digest mismatches, missing blobs, unreferenced blobs, size mismatches,
  unknown media types, unsupported digest algorithms, symlink blobs, nested
  index depth, malformed nested JSON, and blob oversize as findings, not
  crashes.
- Admit the selected directory through the existing directory/stable-root
  helpers so child symbolic links and paths that leave the root are refused.
- Bound JSON bytes, hashed blob bytes, directory entries, and nested index
  depth with named allowances. Refuse oversize or malformed `oci-layout` or
  `index.json` with partial facts preserved when the layout file was readable.

## Acceptance

Synthetic fixtures cover a valid single-platform layout, a multi-platform
index, a missing blob, a digest mismatch, a size mismatch, a symlinked blob,
an oversize index JSON, a nested-index depth limit, and malformed JSON. Tests
cover CLI acceptance, the MCP boundary, provider-capability conformance, and
lifecycle coverage. Limitation delivery is asserted through the parser-owned
`OCI_IMAGE_LAYOUT_LIMITATIONS` wording. The
[usage guide](../../../guides/artifacts/oci-image-layout.md) documents the
result and limits.

## Out of scope

Tar image-layout input, layer decompression, listing layer contents, registry
access, and image execution. Layer contents are a follow-up.
