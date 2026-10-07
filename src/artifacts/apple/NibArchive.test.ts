import { describe, expect, it } from "vitest";

import { decodeNibArchive } from "./NibArchive.js";
import { encodeNibArchiveFixture as encodeArchive } from "./NibArchive.fixture.js";

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
