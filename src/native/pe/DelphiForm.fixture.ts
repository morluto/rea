/**
 * Hand-authored `TPF0` bytes for Delphi/C++Builder form fixtures.
 *
 * Written from the filer-stream layout and kept independent of the production
 * decoder, so a decoder regression cannot hide behind the fixture.
 */

export const delphiBytes = (...values: number[]): Buffer => Buffer.from(values);

/** `ReadStr`: one length byte followed by that many raw bytes. */
export const delphiShortString = (value: string | Buffer): Buffer => {
  const raw = typeof value === "string" ? Buffer.from(value, "latin1") : value;
  return Buffer.concat([Buffer.from([raw.length]), raw]);
};

const sized = (type: number, raw: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(raw.length, 0);
  return Buffer.concat([Buffer.from([type]), length, raw]);
};

export const delphiInt8 = (value: number): Buffer =>
  Buffer.from([2, value & 0xff]);

export const delphiInt16 = (value: number): Buffer => {
  const raw = Buffer.alloc(2);
  raw.writeInt16LE(value, 0);
  return Buffer.concat([Buffer.from([3]), raw]);
};

export const delphiInt32 = (value: number): Buffer => {
  const raw = Buffer.alloc(4);
  raw.writeInt32LE(value, 0);
  return Buffer.concat([Buffer.from([4]), raw]);
};

export const delphiInt64 = (value: bigint): Buffer => {
  const raw = Buffer.alloc(8);
  raw.writeBigInt64LE(value, 0);
  return Buffer.concat([Buffer.from([19]), raw]);
};

export const delphiQWord = (value: bigint): Buffer => {
  const raw = Buffer.alloc(8);
  raw.writeBigUInt64LE(value, 0);
  return Buffer.concat([Buffer.from([22]), raw]);
};

export const delphiFloat32 = (value: number): Buffer => {
  const raw = Buffer.alloc(4);
  raw.writeFloatLE(value, 0);
  return Buffer.concat([Buffer.from([15]), raw]);
};

export const delphiFloat64 = (value: number): Buffer => {
  const raw = Buffer.alloc(8);
  raw.writeDoubleLE(value, 0);
  return Buffer.concat([Buffer.from([23]), raw]);
};

export const delphiLString = (text: string): Buffer =>
  sized(12, Buffer.from(text, "latin1"));

export const delphiUtf8String = (text: string): Buffer =>
  sized(20, Buffer.from(text, "utf8"));

/** `vaUString`: the length prefix counts UTF-16 code units, not bytes. */
export const delphiWideString = (text: string): Buffer => {
  const raw = Buffer.from(text, "utf16le");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(text.length, 0);
  return Buffer.concat([Buffer.from([21]), length, raw]);
};

export const delphiBinary = (length: number): Buffer =>
  sized(10, Buffer.alloc(length, 0xab));

export const delphiList = (...items: Buffer[]): Buffer =>
  Buffer.concat([Buffer.from([1]), ...items, Buffer.from([0])]);

export const delphiSet = (...names: string[]): Buffer =>
  Buffer.concat([
    Buffer.from([11]),
    ...names.map((name) => delphiShortString(name)),
    Buffer.from([0]),
  ]);

export const delphiCollectionItem = (
  position: Buffer | null,
  ...properties: Buffer[]
): Buffer =>
  Buffer.concat([
    position ?? Buffer.alloc(0),
    Buffer.from([1]),
    ...properties,
    Buffer.from([0]),
  ]);

export const delphiCollection = (...items: Buffer[]): Buffer =>
  Buffer.concat([Buffer.from([14]), ...items, Buffer.from([0])]);

export const delphiProperty = (name: string, value: Buffer): Buffer =>
  Buffer.concat([delphiShortString(name), value]);

export const delphiComponent = (
  className: string,
  componentName: string,
  properties: readonly Buffer[] = [],
  options: {
    readonly children?: readonly Buffer[];
    readonly prefix?: readonly number[];
  } = {},
): Buffer =>
  Buffer.concat([
    options.prefix === undefined
      ? Buffer.alloc(0)
      : Buffer.from(options.prefix),
    delphiShortString(className),
    delphiShortString(componentName),
    ...properties,
    Buffer.from([0]),
    ...(options.children ?? []),
    Buffer.from([0]),
  ]);

export const delphiForm = (root: Buffer, signature = "TPF0"): Buffer =>
  Buffer.concat([Buffer.from(signature, "latin1"), root]);

/**
 * A representative Delphi 7 style form: one button on a form, an ANSI caption,
 * a set and a collection, used wherever a PE fixture needs a real RCDATA form.
 */
export const delphiFormFixture = (): Buffer =>
  delphiForm(
    delphiComponent(
      "TForm1",
      "Form1",
      [
        delphiProperty(
          "Caption",
          delphiBytes(6, 5, 0x48, 0x65, 0x6c, 0x6c, 0x6f),
        ),
        delphiProperty("Width", delphiInt32(320)),
        delphiProperty("Visible", delphiBytes(9)),
        delphiProperty("Options", delphiSet("foBold", "foItalic")),
      ],
      {
        children: [
          delphiComponent("TButton", "Button1", [
            delphiProperty("Caption", delphiLString("OK")),
            delphiProperty("Tag", delphiInt8(7)),
          ]),
        ],
      },
    ),
  );
