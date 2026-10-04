# High-address otool capture

`otool-high-address.txt` is captured output from the installed Apple `otool`,
with only its first filename line changed to `fixture:`. It exercises addresses
above JavaScript's safe integer range and the actual `2^N (bytes)` alignment
notation. The minimal Mach-O is generated locally; no binary is checked in.

Reproduce the capture on macOS with Xcode command line tools:

```sh
python3 - <<'PY'
import struct
from pathlib import Path

base = 0xfffffff007004001
header = struct.pack('<8I', 0xfeedfacf, 0x0100000c, 0, 5, 1, 152, 0, 0)
segment = struct.pack(
    '<II16sQQQQIIII', 0x19, 152, b'__TEXT', base, 0x1000, 0, 185, 5, 5, 1, 0,
)
section = struct.pack(
    '<16s16sQQIIIIIIII', b'__text', b'__TEXT', base + 184, 1,
    184, 0, 0, 0, 0x80000400, 0, 0, 0,
)
Path('/tmp/rea-high-address.macho').write_bytes(header + segment + section + b'\xc0')
PY
xcrun otool -l /tmp/rea-high-address.macho
```
