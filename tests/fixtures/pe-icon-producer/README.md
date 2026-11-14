# Real PE icon-resource oracle

`oracle.json` records complete resource-only PE32 and PE32+ files produced by
**Pillow 13.0.0 → GNU windres/ld 2.44**, with declarations and payload hashes read
independently by **pefile 2024.8.26**. The source image is an authored solid-color
RGBA square; no third-party application, icon, model or proprietary bytes are
included. Compressed base64 keeps the recorded transport textual and small.
The test bounds decompression and checks each complete file's size and SHA-256.
It never executes or loads these files as Windows programs.

Pillow creates 16×16 and 256×256 **DIB**, rather than PNG, images. The latter's
262,184-byte resource exercises the high bits of `GRPICONDIRENTRY.dwBytesInRes`;
a 16-bit read changes it to 40. windres compiles the same icon into English
(1033) and Japanese (1041) resource branches, assigning image IDs and updating
group descriptors. pefile locates the actual tree/payloads; Python's independent
`struct` reader decodes each original group record. The producer also checks
that the compiled RT_ICON payloads equal the original Pillow ICO payloads.

The public CLI compares full source ranges/hashes, numeric resource identities,
original group descriptors and same-language RT_ICON links against this oracle.
Encoded width/height **zero** for 256 pixels is intentional and remains raw,
as specified by the existing REA resource contract. This is not image rendering,
Windows language fallback, or a new resource-decoding capability.

Reproduce on Linux with GNU binutils 2.44, its MinGW `windres`, and `/usr/bin/cpp`:

```sh
python3 -m venv /tmp/rea-pe-icon-oracle
/tmp/rea-pe-icon-oracle/bin/pip install Pillow==13.0.0 pefile==2024.8.26
/tmp/rea-pe-icon-oracle/bin/python tests/fixtures/pe-icon-producer/produce.py --check
```

`--windres PATH` and `--ld PATH` select the installed tools. Tool versions are
checked against upstream release 2.44. Full original banners remain recorded as
provenance, while `--check` compares their release fields independently of build
or distributor branding. A different release is still refused. Omit `--check`
to regenerate intentionally, then format the JSON and
review its changed bytes/facts. `--check` compares the **uncompressed complete
files and all oracle facts**; different zlib encodings do not change that proof.
CI uses the recorded files without external producer tools or optional skips.

Production is currently correct for both files. On main `87743d67f`, changing
only the icon descriptor's `readUInt32LE(at + 8)` to `readUInt16LE(at + 8)` left
all **61 tests in four existing PE-resource suites passing**. The two new public
CLI cases fail on the wrong original descriptor length and resulting size-match
fact. The mutation is not part of the contribution; it was restored byte-for-byte
before final verification. Existing malformed, budget, permission, cancellation
and unresolved/foreign-language controls remain in their existing owners.
