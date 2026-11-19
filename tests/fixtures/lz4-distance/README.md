# Native LZ4 long-distance oracle

`oracle.json` is a raw block produced by **liblz4 1.10.0**, not by REA's decoder
or the UnityFS test builder. Current production decodes it correctly. This
fixture protects decoded content identity at the public CLI boundary.

`producer.py` constructs 513 deterministic bytes from SHA-256 digests of ASCII
`rea-lz4-distance:0` through `rea-lz4-distance:16`, repeats that prefix, and appends
`END!` plus NUL. It calls native `LZ4_compress_default`, then checks every byte
using native `LZ4_decompress_safe`. The source is data and is never executed.

Regenerate on a host with Python and liblz4 installed:

```sh
python tests/fixtures/lz4-distance/producer.py > /tmp/lz4-oracle.json
```

No native library or compression tool is needed by CI: it reads the committed
textual block and independently reconstructs the original source recipe. The
recorded producer version describes these encoded bytes; another compressor
version may choose a different valid encoding.

The recorded 526-byte block contains:

- `ff ff f3`: a token and extensions introducing 513 literal bytes.
- After those literals, `01 02`: little-endian match distance **513**.
- `ff ef`: the match extensions, giving a 513-byte match including its base.
- `50` and five final literal bytes.

The decoded size is 1,031 bytes and its SHA-256 is
`ac458e50176297b4a25ed74385e7781a8a8dca03177d89224f08799c4356645e`.

The CLI regression puts this raw block into the existing synthetic UnityFS
carrier, leaving the directory uncompressed. It verifies the member's
content-addressed inventory node, virtual source location, extracted file bytes
and digest, and unchanged carrier bytes. It does not claim a Unity-produced
bundle, CUDA runtime verification, or a native LZ4 frame decoder.

At audited base `a8527d43b`, removing the distance high-byte shift in
`src/gpu/Lz4Block.ts` leaves all 208 existing direct-codec, UnityFS and GPU tests
passing. This new CLI case fails: the decoder still produces 1,031 bytes, but
their hash becomes
`59b9ff4f061bda8b8a290713edc203b75463ed6d38a4b1b8a7a778a5fde33c0f`.
The production mutation is not part of the contribution.
