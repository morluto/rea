# [Feature] Read WeChat mini-program wxapkg containers

## Before submitting
- [x] I searched the open and closed issues and pull requests for a related proposal.
- [x] I understand the contribution scope must be reviewed before integration; open questions are welcome here.
- [x] This request does not include credentials, private samples, or sensitive target data.

## Area
Evidence, artifacts, or reconstruction

## Current limitation
`inspect-artifact` treats a `.wxapkg` WeChat mini-program package as an opaque `file`. The package is a plain big-endian container — `0xBE` mark, u32 header fields, `0xED` mark, u32 file count, then a name/offset/size table followed by verbatim member bytes — yet today an analyst must leave the Evidence workflow and run a standalone unpacker just to enumerate `app-config.json`, `app-service.js`, `pages/`, `subpackages/`, and media members. Nested artifacts inside the package (WASM, images, further containers) are therefore never classified or hashed.

## Use cases
Mini-program and mini-game security review increasingly resembles mobile app analysis: the package is the shipping artifact, everything interesting is inside it. During a recent local review of a Cocos-based mini-program I unpacked a wxapkg by hand to reach the same `app-config.json`/subpackage layout this reader would expose directly. The same layout is produced by every public unpacker, so member lists are easy to cross-validate.

## Desired outcome and success criteria
- `inspect-artifact <pkg>.wxapkg` reports `format: wxapkg` (name TBD) with a manifest graph: one occurrence per member, source offsets/sizes preserved, member contents hashed where readable.
- `extract-artifact` materializes members byte-identically under their declared paths; `app-config.json`, `app-service.js`, `pages/*`, `subpackages/*`, and asset members appear in the manifest.
- Malformed headers/tables produce typed failures, not partial output; out-of-bounds member ranges fail closed.
- Packages whose leading bytes are `V1MMWX` (the encrypted PC-client variant) are identified and reported as encrypted/unavailable rather than misparsed — no decryption in this scope.
- Verified against at least one real producer sample with member bytes cross-checked against an independent unpacker.

## Expected interaction with targets
Read existing files or captured data

## Target and scope details (optional)
Non-goals for this request: decrypting `V1MMWX` PC packages (wxid-derived AES-256; protection recovery would need its own scope decision), executing mini-program code, reconstructing `wxml/wxss` sources, or live-device acquisition. Scope question for maintainers if useful: whether Android-cache-acquired packages (self-owned device, standard extraction path) are acceptable validation samples.

## Verification available so far
I can suggest a sample or manual check

## Verification details (optional)
The format is publicly documented and independently re-implemented several times (see References), so member extraction results can be compared byte-for-byte against an existing unpacker on the same sample — the same validation methodology used for the UnityFS reader (PR #7699). I can obtain a self-owned mini-program package for verification; no sample is attached here.

## Alternatives considered
Standalone unpackers exist in PHP/Go/Rust/Python (wxappUnpacker, KillWxapkg, unwx) but produce loose files without REA's manifest graph, hashes, coverage reporting, or nested-artifact classification — and none is maintained as a library inside an evidence pipeline. Treating the package as an opaque file (current behavior) loses the member inventory entirely.

## Possible direction
Follow the UnityFS reader shape (merged in #7699): bounded header parse (18-byte header), bounded file-table parse with per-row bounds before allocation, member streams read lazily through `readPckBytes`-style ranged reads, path validation through the shared artifact path rule, expansion-budget charging on declared member bytes, `ArtifactEntry.unavailable`-style retention for undecodable members, `V1MMWX` detection surfaced as an encrypted status. Table rows carry only name/offset/size — a much smaller format than UnityFS.

## References
- Public format write-up: github.com/last0monster/wxappUnpacker-1 `DETAILS.md` (struct layout, big-endian fields, member layout)
- Independent implementations for cross-validation: `unwx` (Rust, docs.rs source shows the same marks and table shape), `KillWxapkg` (Go)
- Prior integration precedent in this repository: #7699 (UnityFS), Godot PCK reader
