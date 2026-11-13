"""Produce an inert tensor-storage oracle with the pinned Rust implementation."""
import argparse
import base64
import hashlib
import json
import math
from pathlib import Path

import safetensors

VERSION = "0.7.0"
DTYPES = {
    "bool": 1, "uint8": 1, "int8": 1,
    "uint16": 2, "int16": 2, "bfloat16": 2, "float16": 2,
    "float32": 4, "float64": 8, "int32": 4, "uint32": 4,
    "int64": 8, "uint64": 8, "complex64": 8,
    "float8_e4m3fn": 1, "float8_e5m2": 1, "float8_e8m0fnu": 1,
    "float4_e2m1fn_x2": 1,
}


def produce():
    if safetensors.__version__ != VERSION:
        raise RuntimeError(f"requires safetensors=={VERSION}")
    inputs = {}
    for index, (dtype, width) in enumerate(DTYPES.items()):
        # These are Python API dtype names, not REA's wire-type table. In
        # particular the Rust producer expands the packed F4 final dimension.
        inputs[f"tensor/{dtype}~{index}"] = {
            "dtype": dtype, "shape": [2, 3],
            "data": bytes((index * 17 + at * 13) % 256 for at in range(6 * width)),
        }
    inputs["scalar"] = {"dtype": "float32", "shape": [], "data": bytes([0, 0, 128, 63])}
    inputs["empty"] = {"dtype": "bfloat16", "shape": [0, 7], "data": b""}
    metadata = {"producer/~\ufeff": "Rust safetensors 0.7.0; literal \ufeff metadata"}
    encoded = safetensors.serialize(inputs, metadata=metadata)
    # Independently decode the exact emitted bytes with the official Rust
    # reader; no REA fixture builder, parser or dtype table participates.
    decoded = dict(safetensors.deserialize(encoded))
    assert decoded.keys() == inputs.keys()
    header_bytes = int.from_bytes(encoded[:8], "little")
    header = json.loads(encoded[8:8 + header_bytes])
    assert header.pop("__metadata__") == metadata
    tensors = []
    for name in sorted(decoded):
        row = decoded[name]
        assert bytes(row["data"]) == inputs[name]["data"]
        assert row["dtype"] == header[name]["dtype"]
        assert row["shape"] == header[name]["shape"]
        start, end = header[name]["data_offsets"]
        assert encoded[8 + header_bytes + start:8 + header_bytes + end] == row["data"]
        tensors.append({
            "name": name, "type": row["dtype"], "shape": [str(n) for n in row["shape"]],
            "json_pointer": "/" + name.replace("~", "~0").replace("/", "~1"),
            "parameter_count": str(math.prod(row["shape"])),
            "data_offset": start, "file_offset": 8 + header_bytes + start,
            "byte_length": len(row["data"]),
        })
    return {
        "producer": f"safetensors=={VERSION} (Rust serialize + deserialize)",
        "file_base64": base64.b64encode(encoded).decode(),
        "file_size": len(encoded), "sha256": hashlib.sha256(encoded).hexdigest(),
        "header_sha256": hashlib.sha256(encoded[:8 + header_bytes]).hexdigest(),
        "tensor_data_offset": 8 + header_bytes,
        "metadata": metadata, "tensors": tensors,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = Path(__file__).with_name("oracle.json")
    text = json.dumps(produce(), indent=2, ensure_ascii=True) + "\n"
    if args.check:
        if json.loads(target.read_text()) != json.loads(text):
            raise SystemExit("safetensors producer oracle differs")
        print("Pinned Rust producer and reader reproduce oracle.json exactly")
    else:
        target.write_text(text)
        print(target)
