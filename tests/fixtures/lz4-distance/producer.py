"""Generate a raw-block oracle with liblz4; never execute the decoded bytes."""

import ctypes
import ctypes.util
import hashlib
import json


library = ctypes.util.find_library("lz4")
assert library is not None, "liblz4 is required only to regenerate this fixture"
lz4 = ctypes.CDLL(library)
lz4.LZ4_versionString.restype = ctypes.c_char_p
lz4.LZ4_compressBound.argtypes = [ctypes.c_int]
lz4.LZ4_compressBound.restype = ctypes.c_int
lz4.LZ4_compress_default.argtypes = [
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_int,
    ctypes.c_int,
]
lz4.LZ4_compress_default.restype = ctypes.c_int
lz4.LZ4_decompress_safe.argtypes = lz4.LZ4_compress_default.argtypes
lz4.LZ4_decompress_safe.restype = ctypes.c_int

prefix = b"".join(
    hashlib.sha256(f"rea-lz4-distance:{index}".encode("ascii")).digest()
    for index in range(17)
)[:513]
source = prefix + prefix + b"END!\0"
destination = ctypes.create_string_buffer(lz4.LZ4_compressBound(len(source)))
size = lz4.LZ4_compress_default(
    source, destination, len(source), len(destination)
)
assert size > 0
encoded = destination.raw[:size]
decoded = ctypes.create_string_buffer(len(source))
assert lz4.LZ4_decompress_safe(encoded, decoded, size, len(source)) == len(source)
assert decoded.raw == source

print(json.dumps({
    "producer": "liblz4 " + lz4.LZ4_versionString().decode("ascii"),
    "encoded_hex": encoded.hex(),
    "decoded_bytes": len(source),
    "decoded_sha256": hashlib.sha256(source).hexdigest(),
}, indent=2))
