import { describe, expect, it } from "vitest";

import { decodeNibArchive } from "./NibArchive.js";
import { encodeNibArchiveFixture as encodeArchive } from "./NibArchive.fixture.js";
import { InterfaceBuilderDecodeBudgetExceeded } from "./InterfaceBuilderDecodeBudget.js";

const archiveWithOverlappingObjectRanges = (objectCount: number): Buffer => {
  const objectRecords = Buffer.alloc(objectCount * 3);
  for (let index = 0; index < objectCount; index += 1)
    objectRecords.set([0x80, 0x80, 0x81], index * 3);
  const keys = Buffer.from([0x81, 0x78]);
  const values = Buffer.from([0x80, 10, 0, 0, 0, 0]);
  const className = Buffer.from("NSObject");
  const classes = Buffer.concat([
    Buffer.from([className.length]),
    Buffer.from([0x80]),
    className,
  ]);
  const objectsOffset = 50;
  const keysOffset = objectsOffset + objectRecords.length;
  const valuesOffset = keysOffset + keys.length;
  const classesOffset = valuesOffset + values.length;
  const header = Buffer.alloc(50);
  header.write("NIBArchive", 0, "ascii");
  header.writeUInt32LE(1, 10);
  header.writeUInt32LE(10, 14);
  header.writeUInt32LE(objectCount, 18);
  header.writeUInt32LE(objectsOffset, 22);
  header.writeUInt32LE(1, 26);
  header.writeUInt32LE(keysOffset, 30);
  header.writeUInt32LE(1, 34);
  header.writeUInt32LE(valuesOffset, 38);
  header.writeUInt32LE(1, 42);
  header.writeUInt32LE(classesOffset, 46);
  return Buffer.concat([header, objectRecords, keys, values, classes]);
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

  it("budgets overlapping object value ranges before materializing their fields", () => {
    const archive = archiveWithOverlappingObjectRanges(700_000);
    let thrown: unknown;
    try {
      decodeNibArchive(archive);
    } catch (cause: unknown) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(InterfaceBuilderDecodeBudgetExceeded);
    expect(thrown).toHaveProperty(
      "message",
      expect.stringMatching(/projected field ranges/u),
    );
  });
});
