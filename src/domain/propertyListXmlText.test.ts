import { expect, it, onTestFinished, vi } from "vitest";

import {
  decodeXmlPlistText,
  inspectXmlPlistTextEncoding,
  XmlPlistTextDecodeError,
} from "./propertyListXmlText.js";

it.each([
  [
    Buffer.from(
      '<?xml version="1.0" encoding="ISO-8859-1"?><plist><string>caf\xe9</string></plist>',
      "latin1",
    ),
    "unsupported-encoding",
  ],
  [
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><plist><string>\xff</string></plist>',
      "latin1",
    ),
    "invalid-bytes",
  ],
  [Buffer.from([0xff, 0xfe, 0, 0, 0x3c, 0, 0, 0]), "unsupported-encoding"],
  [Buffer.from([0, 0, 0xfe, 0xff, 0, 0, 0, 0x3c]), "unsupported-encoding"],
  [
    Buffer.from('<?xml version="1.0" encoding="UTF-16"?><plist/>'),
    "encoding-mismatch",
  ],
  [
    Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><plist/>'),
    "unsupported-encoding",
  ],
  [Buffer.from([0xff, 0xfe, 0x3c]), "invalid-bytes"],
  [
    Buffer.from("<?xml version='1.0' encoding='ISO-8859-1'?><plist/>"),
    "unsupported-encoding",
  ],
  [
    Buffer.from('<?xml version="1.0" encoding="foo?bar"?><plist/>'),
    "unsupported-encoding",
  ],
] as const)("tags XML decoding failures as %s", (bytes, reason) => {
  expect(() => decodeXmlPlistText(bytes)).toThrow(
    expect.objectContaining({
      name: "XmlPlistTextDecodeError",
      reason,
      kind: reason === "unsupported-encoding" ? "unsupported" : "malformed",
    } satisfies Partial<XmlPlistTextDecodeError>),
  );
});

it("inspects padded XML declarations directly from bytes without decoding them and reuses the result", () => {
  const decodeSpy = vi.spyOn(TextDecoder.prototype, "decode");
  onTestFinished(() => decodeSpy.mockRestore());

  const padding = " ".repeat(4 * 1024 * 1024);
  const utf8Latin1 = Buffer.from(
    `<?xml version="1.0"${padding} encoding="ISO-8859-1"?><plist/>`,
    "latin1",
  );
  const utf16leLatin1 = Buffer.from(
    `\uFEFF<?xml version="1.0"${padding} encoding="ISO-8859-1"?><plist/>`,
    "utf16le",
  );
  const utf16beLatin1 = Buffer.from(utf16leLatin1).swap16();

  for (const sample of [utf8Latin1, utf16leLatin1, utf16beLatin1]) {
    expect(() => inspectXmlPlistTextEncoding(sample)).toThrow(
      expect.objectContaining({
        name: "XmlPlistTextDecodeError",
        reason: "unsupported-encoding",
      }),
    );
  }

  const utf16leMismatch = Buffer.from(
    `\uFEFF<?xml version="1.0"${padding} encoding="UTF-8"?><plist/>`,
    "utf16le",
  );
  expect(() => inspectXmlPlistTextEncoding(utf16leMismatch)).toThrow(
    expect.objectContaining({
      name: "XmlPlistTextDecodeError",
      reason: "encoding-mismatch",
    }),
  );

  const utf8Valid = Buffer.from(
    `<?xml version="1.0" fooencoding="ISO-8859-1"${padding} encoding="UTF-8"?><plist/>`,
  );
  const inspected = inspectXmlPlistTextEncoding(utf8Valid);
  expect(inspected).toEqual({ encoding: "utf-8", declarationVerified: true });
  expect(decodeSpy).toHaveBeenCalledTimes(0);

  const smallUtf8 = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?><plist><string>hi</string></plist>',
  );
  const smallInspected = inspectXmlPlistTextEncoding(smallUtf8);
  expect(smallInspected).toEqual({
    encoding: "utf-8",
    declarationVerified: true,
  });
  expect(decodeSpy).toHaveBeenCalledTimes(0);
  expect(decodeXmlPlistText(smallUtf8, smallInspected)).toContain("hi");
  expect(decodeSpy).toHaveBeenCalledTimes(1);

  const oversizedEncodingName = Buffer.from(
    `<?xml version="1.0" encoding="${"a".repeat(256 * 1024)}"?><plist/>`,
  );
  let captured: unknown;
  try {
    inspectXmlPlistTextEncoding(oversizedEncodingName);
  } catch (error: unknown) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(XmlPlistTextDecodeError);
  expect((captured as XmlPlistTextDecodeError).reason).toBe(
    "unsupported-encoding",
  );
  expect(
    ((captured as XmlPlistTextDecodeError).declaredEncoding ?? "").length,
  ).toBeLessThanOrEqual(67);
});
