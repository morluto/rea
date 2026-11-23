"""Regenerate inert scalar wire samples with the official Python protobuf runtime."""
import argparse
import base64
import hashlib
import json
import math
from pathlib import Path

import google.protobuf
from google.protobuf import descriptor_pb2, descriptor_pool, message_factory

VERSION = "6.33.5"
assert google.protobuf.__version__ == VERSION, google.protobuf.__version__
F = descriptor_pb2.FieldDescriptorProto
CASES = [
    ("double", F.TYPE_DOUBLE, [-0.0, 1.5, -1.5]),
    ("float", F.TYPE_FLOAT, [-0.0, 1.5, -1.5]),
    ("int64", F.TYPE_INT64, [-(2**63), -1, 0, 2**53 + 1, 2**63 - 1]),
    ("uint64", F.TYPE_UINT64, [0, 2**53 + 1, 2**64 - 1]),
    ("int32", F.TYPE_INT32, [-(2**31), -1, 0, 2**31 - 1]),
    ("fixed64", F.TYPE_FIXED64, [0, 2**53 + 1, 2**64 - 1]),
    ("fixed32", F.TYPE_FIXED32, [0, 2**31 + 1, 2**32 - 1]),
    ("bool", F.TYPE_BOOL, [False, True, False]),
    ("uint32", F.TYPE_UINT32, [0, 2**31 + 1, 2**32 - 1]),
    ("sfixed32", F.TYPE_SFIXED32, [-(2**31), -1, 0, 2**31 - 1]),
    ("sfixed64", F.TYPE_SFIXED64, [-(2**63), -1, 0, 2**53 + 1, 2**63 - 1]),
    ("sint32", F.TYPE_SINT32, [-(2**31), -1, 0, 2**31 - 1]),
    ("sint64", F.TYPE_SINT64, [-(2**63), -1, 0, 2**53 + 1, 2**63 - 1]),
]


def display(value):
    if isinstance(value, bool):
        return str(value).lower()
    if isinstance(value, float) and value == 0 and math.copysign(1, value) < 0:
        return "-0"
    return str(value)


def schema(packed):
    file = descriptor_pb2.FileDescriptorProto(
        name="scalars.proto", package="oracle", syntax="proto3"
    )
    message = file.message_type.add(name="Scalars")
    for number, (name, kind, _) in enumerate(CASES, 1):
        field = message.field.add(
            name=name, number=number, type=kind, label=F.LABEL_REPEATED
        )
        field.options.packed = packed
    pool = descriptor_pool.DescriptorPool()
    pool.Add(file)
    cls = message_factory.GetMessageClass(pool.FindMessageTypeByName("oracle.Scalars"))
    descriptor = descriptor_pb2.FileDescriptorSet()
    descriptor.file.add().CopyFrom(file)
    return cls, descriptor.SerializeToString(deterministic=True)


def varint(data, at):
    value, shift = 0, 0
    while True:
        byte = data[at]
        at += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, at
        shift += 7


def wire_rows(data, decoded):
    """Independent wire coordinates/raw unsigned facts; semantic values come from Python."""
    rows, occurrences, at = [], {}, 0
    while at < len(data):
        start = at
        tag, at = varint(data, at)
        number, wire = tag >> 3, tag & 7
        name, _, _ = CASES[number - 1]
        values = list(getattr(decoded, name))
        raw = None
        if wire == 2:
            length, at = varint(data, at)
            payload, at = at, at + length
            semantic = json.dumps([display(v) for v in values], separators=(",", ":"))
        else:
            payload = at
            if wire == 0:
                raw, at = varint(data, at)
            else:
                length = {1: 8, 5: 4}[wire]
                raw = int.from_bytes(data[at:at + length], "little")
                at += length
            index = occurrences.get(number, 0)
            semantic = display(values[index])
            occurrences[number] = index + 1
        row = dict(
            number=number, wire_type={0: "varint", 1: "i64", 2: "len", 5: "i32"}[wire],
            offset=start, bytes=at - start, payload_offset=payload, payload_bytes=at - payload,
            schema_name=name, schema_type=name, schema_status="decoded", schema_value=semantic,
        )
        if raw is not None:
            row["value"] = str(raw)
        rows.append(row)
    return rows


def generate():
    schemas = [schema(packed) for packed in (False, True)]
    samples = []
    for packed, (cls, descriptor) in zip((False, True), schemas):
        message = cls()
        for name, _, values in CASES:
            getattr(message, name).extend(values)
        wire = message.SerializeToString(deterministic=True)
        # Protobuf requires parsers to accept either representation regardless of the option.
        for other, _ in schemas:
            decoded = other.FromString(wire)
            for name, _, values in CASES:
                assert [display(v) for v in getattr(decoded, name)] == [display(v) for v in values]
        samples.append(dict(
            encoding="packed" if packed else "unpacked",
            descriptor_base64=base64.b64encode(descriptor).decode(),
            body_base64=base64.b64encode(wire).decode(),
            body_sha256=hashlib.sha256(wire).hexdigest(),
            fields=wire_rows(wire, decoded),
        ))
    return json.dumps(dict(producer=f"google.protobuf {VERSION}", samples=samples), indent=2) + "\n"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    path = Path(__file__).with_name("oracle.json")
    output = generate()
    if args.check:
        assert path.read_text() == output, "Scalar oracle differs; regenerate and inspect the diff"
    else:
        path.write_text(output)
    print(f"Python protobuf {VERSION}: 13 scalar types, 2 encodings, 4 cross-option decodes verified")
