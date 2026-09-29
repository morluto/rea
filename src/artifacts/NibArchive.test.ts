import { describe, expect, it } from "vitest";

import { decodeNibArchive } from "./NibArchive.js";

const encodeArchive = (input: {
  readonly classes: readonly string[];
  readonly objects: readonly {
    readonly classIndex: number;
    readonly values: Readonly<
      Record<string, number | string | boolean | null | { ref: number }>
    >;
  }[];
}): Buffer => {
  const keys = [
    ...new Set(input.objects.flatMap(({ values }) => Object.keys(values))),
  ];
  const keyIndex = new Map(keys.map((key, index) => [key, index]));
  const valueRecords = input.objects.flatMap(({ values }) =>
    Object.entries(values).map(([key, value]) =>
      Buffer.concat([varint(keyIndex.get(key) ?? 0), encodeValue(value)]),
    ),
  );
  let valueStart = 0;
  const records = input.objects.map(({ classIndex, values }) => {
    const count = Object.keys(values).length;
    const result = Buffer.concat([
      varint(classIndex),
      varint(valueStart),
      varint(count),
    ]);
    valueStart += count;
    return result;
  });
  const objects = Buffer.concat(records);
  const encodedKeys = Buffer.concat(
    keys.map((key) =>
      Buffer.concat([varint(Buffer.byteLength(key)), Buffer.from(key)]),
    ),
  );
  const values = Buffer.concat(valueRecords);
  const classes = Buffer.concat(
    input.classes.map((name) => {
      const bytes = Buffer.from(name);
      return Buffer.concat([varint(bytes.length), varint(0), bytes]);
    }),
  );
  const objectsOffset = 50;
  const keysOffset = objectsOffset + objects.length;
  const valuesOffset = keysOffset + encodedKeys.length;
  const classesOffset = valuesOffset + values.length;
  const header = Buffer.alloc(50);
  header.write("NIBArchive", 0, "ascii");
  header.writeUInt32LE(1, 10);
  header.writeUInt32LE(10, 14);
  header.writeUInt32LE(input.objects.length, 18);
  header.writeUInt32LE(objectsOffset, 22);
  header.writeUInt32LE(keys.length, 26);
  header.writeUInt32LE(keysOffset, 30);
  header.writeUInt32LE(valueStart, 34);
  header.writeUInt32LE(valuesOffset, 38);
  header.writeUInt32LE(input.classes.length, 42);
  header.writeUInt32LE(classesOffset, 46);
  return Buffer.concat([header, objects, encodedKeys, values, classes]);
};

const varint = (value: number): Buffer => {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining === 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
};

const encodeValue = (
  value: number | string | boolean | null | { ref: number },
): Buffer => {
  if (typeof value === "boolean") return Buffer.from([value ? 4 : 5]);
  if (value === null) return Buffer.from([9]);
  if (typeof value === "number") {
    const bytes = Buffer.alloc(5);
    bytes[0] = 2;
    bytes.writeInt32LE(value, 1);
    return bytes;
  }
  if (typeof value === "object") {
    const bytes = Buffer.alloc(5);
    bytes[0] = 10;
    bytes.writeUInt32LE(value.ref, 1);
    return bytes;
  }
  const data = Buffer.from(value);
  return Buffer.concat([Buffer.from([8]), varint(data.length), data]);
};

describe("NIBArchive decoder", () => {
  it("decodes bounded object, key, class, and reference tables", () => {
    const archive = encodeArchive({
      classes: ["NSView\0", "NSString\0"],
      objects: [
        { classIndex: 0, values: { child: { ref: 1 }, enabled: true } },
        { classIndex: 1, values: { text: "Button" } },
      ],
    });
    const decoded = decodeNibArchive(archive);

    expect(decoded.objects).toEqual([
      {
        id: 0,
        class_name: "NSView",
        values: { child: { $nib_object_ref: 1 }, enabled: true },
      },
      {
        id: 1,
        class_name: "NSString",
        values: { text: { $nib_data_base64: "QnV0dG9u" } },
      },
    ]);
    expect(decoded.coder_version).toBe(10);
  });

  it("rejects malformed references and unsupported format versions", () => {
    const valid = encodeArchive({
      classes: ["NSObject"],
      objects: [{ classIndex: 0, values: {} }],
    });
    const invalidVersion = Buffer.from(valid);
    invalidVersion.writeUInt32LE(2, 10);
    expect(() => decodeNibArchive(invalidVersion)).toThrow(/Unsupported/u);
    const invalidReference = encodeArchive({
      classes: ["NSObject"],
      objects: [{ classIndex: 0, values: { child: { ref: 4 } } }],
    });
    expect(() => decodeNibArchive(invalidReference)).toThrow(
      /object reference/u,
    );
  });
});
