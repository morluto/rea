import { describe, expect, it } from "vitest";
import type {
  DelphiFormObject,
  DelphiFormProperty,
} from "../../domain/native/delphiForm.js";
import {
  decodeDelphiFormStream,
  detectDelphiFormSignature,
} from "./DelphiFormStream.js";

import {
  delphiBinary as binary,
  delphiBytes as bytes,
  delphiCollection as collection,
  delphiCollectionItem as collectionItem,
  delphiComponent as component,
  delphiFloat32 as float32,
  delphiFloat64 as float64,
  delphiForm as form,
  delphiInt16 as int16,
  delphiInt32 as int32,
  delphiInt64 as int64,
  delphiInt8 as int8,
  delphiList as list,
  delphiLString as lString,
  delphiProperty as property_,
  delphiQWord as qword,
  delphiSet as setOf,
  delphiUtf8String as utf8String,
  delphiWideString as wideString,
} from "./DelphiForm.fixture.js";

const decode = (payload: Buffer, codePage?: string) =>
  codePage === undefined
    ? decodeDelphiFormStream(payload, 0, payload.length)
    : decodeDelphiFormStream(payload, 0, payload.length, {
        code_page: codePage,
      });

const rootOf = (payload: Buffer, codePage?: string): DelphiFormObject => {
  const decoded = decode(payload, codePage);
  expect(decoded?.root).toBeDefined();
  const root = decoded?.root;
  if (root === null || root === undefined) throw new Error("Missing root");
  return root;
};

const propertyOf = (
  object: DelphiFormObject,
  name: string,
): DelphiFormProperty => {
  const found = object.properties.find(
    ({ name: label }) => label.text === name,
  );
  if (found === undefined) throw new Error(`Missing property ${name}`);
  return found;
};

describe("Delphi form signature detection", () => {
  it("matches TPF0 and TPF1 at the start of a payload", () => {
    expect(detectDelphiFormSignature(form(bytes(0)), 0, 5)?.version).toBe(
      "boVersion0",
    );
    expect(
      detectDelphiFormSignature(form(bytes(0), "TPF1"), 0, 5)?.version,
    ).toBe("boVersion1");
  });

  it("reports bytes before the signature verbatim without interpreting them", () => {
    const payload = Buffer.concat([
      bytes(0xff, 0x0a, 0x00),
      form(component("TForm1", "Form1")),
    ]);
    const signature = detectDelphiFormSignature(payload, 0, payload.length);
    expect(signature?.prefix).toMatchObject({
      location: { offset: 0, bytes: 3 },
      bytes_hex: "ff0a00",
    });
    expect(signature?.prefix?.note).toContain("unknown");
    expect(decode(payload)?.root?.class_name?.text).toBe("TForm1");
  });

  it("does not claim a form when no signature is present", () => {
    expect(detectDelphiFormSignature(Buffer.from("Hello"), 0, 5)).toBeNull();
    expect(decode(Buffer.from("Hello"))).toBeNull();
  });

  it("does not search the whole payload for a signature", () => {
    const payload = Buffer.concat([
      Buffer.alloc(64, 0x20),
      Buffer.from("TPF0", "latin1"),
    ]);
    expect(detectDelphiFormSignature(payload, 0, payload.length)).toBeNull();
  });
});

describe("Delphi form object tree", () => {
  it("decodes class and component names with byte offsets", () => {
    const root = rootOf(form(component("TForm1", "Form1")));
    expect(root.class_name).toMatchObject({
      text: "TForm1",
      code_page: "windows-1252",
      location: { offset: 4, bytes: 7 },
    });
    expect(root.component_name).toMatchObject({
      text: "Form1",
      location: { offset: 11, bytes: 6 },
    });
    expect(root.location).toEqual({ offset: 4, bytes: 15 });
    expect(root.unknown).toBeNull();
  });

  it("decodes nested components", () => {
    const root = rootOf(
      form(
        component("TForm1", "Form1", [], {
          children: [
            component("TButton", "Button1"),
            component("TPanel", "Panel1", [], {
              children: [component("TLabel", "Label1")],
            }),
          ],
        }),
      ),
    );
    expect(root.children.map(({ class_name }) => class_name?.text)).toEqual([
      "TButton",
      "TPanel",
    ]);
    expect(root.children[1]?.children[0]?.component_name?.text).toBe("Label1");
  });

  it("decodes filer flags and the child position", () => {
    const root = rootOf(
      form(
        component("TForm1", "Form1", [], {
          children: [
            component("TButton", "Button1", [], {
              prefix: [0xf6, 4, 7, 0, 0, 0],
            }),
          ],
        }),
      ),
    );
    const child = root.children[0];
    expect(child?.flags).toEqual(["ffChildPos", "ffInline"]);
    expect(child?.child_position).toBe("7");
  });

  it("keeps inherited and inline flags distinct", () => {
    const root = rootOf(
      form(component("TForm1", "Form1", [], { prefix: [0xf5] })),
    );
    expect(root.flags).toEqual(["ffInherited", "ffInline"]);
  });
});

describe("Delphi form property values", () => {
  it("decodes scalar value types with their declared widths", () => {
    const root = rootOf(
      form(
        component("TForm1", "Form1", [
          property_("Tag", int8(-5)),
          property_("Width", int16(-300)),
          property_("Height", int32(70000)),
          property_("Big", int64(-9007199254740993n)),
          property_("Unsigned", qword(18446744073709551615n)),
          property_("Ratio", float32(1.5)),
          property_("Scale", float64(2.5)),
        ]),
      ),
    );
    expect(propertyOf(root, "Tag").value).toMatchObject({
      kind: "integer",
      text: "-5",
      width: 8,
      signed: true,
    });
    expect(propertyOf(root, "Width").value).toMatchObject({
      kind: "integer",
      text: "-300",
      width: 16,
    });
    expect(propertyOf(root, "Height").value).toMatchObject({
      kind: "integer",
      text: "70000",
      width: 32,
    });
    expect(propertyOf(root, "Big").value).toMatchObject({
      kind: "integer",
      text: "-9007199254740993",
      width: 64,
      signed: true,
    });
    expect(propertyOf(root, "Unsigned").value).toMatchObject({
      kind: "integer",
      text: "18446744073709551615",
      width: 64,
      signed: false,
    });
    expect(propertyOf(root, "Ratio").value).toMatchObject({
      kind: "float",
      text: "1.5",
      note: "IEEE-754 binary32.",
    });
    expect(propertyOf(root, "Scale").value).toMatchObject({
      kind: "float",
      text: "2.5",
    });
    expect(propertyOf(root, "Height").value_type).toBe("vaInt32");
  });

  it("decodes the ten-byte x87 extended value and keeps its bytes", () => {
    const raw = Buffer.concat([
      bytes(5),
      Buffer.from("0000000000000080ff3f", "hex"),
    ]);
    const root = rootOf(
      form(component("TForm1", "Form1", [property_("Angle", raw)])),
    );
    const value = propertyOf(root, "Angle").value;
    expect(value).toMatchObject({ kind: "float", text: "1" });
    expect(value).toMatchObject({
      bytes_hex: "0000000000000080ff3f",
      note: expect.stringContaining("extra precision is not retained"),
    });
  });

  it("decodes currency and TDateTime without inventing a calendar date", () => {
    const currency = Buffer.alloc(8);
    currency.writeBigInt64LE(12345n, 0);
    const date = Buffer.alloc(8);
    date.writeDoubleLE(0.5, 0);
    const root = rootOf(
      form(
        component("TForm1", "Form1", [
          property_("Price", Buffer.concat([bytes(16), currency])),
          property_("Stamp", Buffer.concat([bytes(17), date])),
        ]),
      ),
    );
    expect(propertyOf(root, "Price").value).toMatchObject({
      kind: "float",
      text: "1.2345",
      note: expect.stringContaining("scaled by 10000"),
    });
    expect(propertyOf(root, "Stamp").value).toMatchObject({
      kind: "float",
      text: "0.5",
      note: expect.stringContaining("not converted to a calendar date"),
    });
  });

  it("formats currency from the integer without rounding the quotient", () => {
    const currency = Buffer.alloc(8);
    currency.writeBigInt64LE(9223372036854775807n, 0);
    const root = rootOf(
      form(
        component("TForm1", "Form1", [
          property_("Price", Buffer.concat([bytes(16), currency])),
        ]),
      ),
    );
    expect(propertyOf(root, "Price").value).toMatchObject({
      kind: "float",
      text: "922337203685477.5807",
    });
  });
});

describe("Delphi form string and structural values", () => {
  it("decodes strings with the recorded code page and retains their bytes", () => {
    const root = rootOf(
      form(
        component("TForm1", "Form1", [
          property_("Caption", bytes(6, 2, 0x43, 0xe9)),
          property_("Name", bytes(7, 2, 0x53, 0xe9)),
          property_("Hint", lString("long caption")),
          property_("Text", utf8String("naïve")),
          property_("Wide", wideString("宽字符串")),
        ]),
      ),
    );
    expect(propertyOf(root, "Caption").value).toMatchObject({
      kind: "string",
      text: "Cé",
      bytes_hex: "43e9",
      code_page: "windows-1252",
    });
    expect(propertyOf(root, "Name").value).toMatchObject({
      kind: "identifier",
      text: "Sé",
      bytes_hex: "53e9",
    });
    expect(propertyOf(root, "Hint").value).toMatchObject({
      kind: "string",
      text: "long caption",
      code_page: "windows-1252",
    });
    expect(propertyOf(root, "Text").value).toMatchObject({
      kind: "string",
      text: "naïve",
      code_page: "utf-8",
    });
    expect(propertyOf(root, "Wide").value).toMatchObject({
      kind: "string",
      text: "宽字符串",
      code_page: "utf-16le",
    });
  });

  it("decodes strings with a caller-supplied code page", () => {
    const payload = form(
      component("TForm1", "Form1", [property_("Caption", bytes(6, 1, 0xe9))]),
    );
    expect(propertyOf(rootOf(payload), "Caption").value).toMatchObject({
      text: "é",
      code_page: "windows-1252",
    });
    expect(
      propertyOf(rootOf(payload, "windows-1251"), "Caption").value,
    ).toMatchObject({ text: "й", code_page: "windows-1251" });
  });

  it("decodes binary payloads as binary and caps their hex projection", () => {
    const root = rootOf(
      form(component("TForm1", "Form1", [property_("Data", binary(200))])),
    );
    expect(propertyOf(root, "Data").value).toMatchObject({
      kind: "binary",
      declared_bytes: 200,
      truncated: true,
    });
    const value = propertyOf(root, "Data").value;
    if (value.kind !== "binary") throw new Error("Expected binary");
    expect(value.bytes_hex).toHaveLength(256);
  });

  it("decodes lists, sets and collections", () => {
    const root = rootOf(
      form(
        component("TForm1", "Form1", [
          property_("Items", list(int32(1), bytes(6, 1, 0x41), bytes(9))),
          property_("Options", setOf("foBold", "foItalic")),
          property_(
            "Columns",
            collection(
              collectionItem(int8(0), property_("Width", int32(64))),
              collectionItem(null, property_("Width", int32(128))),
            ),
          ),
        ]),
      ),
    );
    expect(propertyOf(root, "Items").value).toMatchObject({
      kind: "list",
      items: [
        { kind: "integer", text: "1" },
        { kind: "string", text: "A" },
        { kind: "boolean", value: true },
      ],
    });
    expect(propertyOf(root, "Options").value).toMatchObject({
      kind: "set",
      names: [{ text: "foBold" }, { text: "foItalic" }],
    });
    const columns = propertyOf(root, "Columns").value;
    expect(columns).toMatchObject({ kind: "collection" });
    if (columns.kind !== "collection") throw new Error("Expected collection");
    expect(columns.items).toHaveLength(2);
    expect(columns.items[0]?.position).toBe("0");
    expect(columns.items[0]?.properties[0]).toMatchObject({
      name: { text: "Width" },
      value: { kind: "integer", text: "64" },
    });
    expect(columns.items[1]?.position).toBeNull();
  });

  it("records null and nil as distinct value kinds", () => {
    const root = rootOf(
      form(
        component("TForm1", "Form1", [
          property_("Empty", bytes(0)),
          property_("Pointer", bytes(13)),
        ]),
      ),
    );
    expect(propertyOf(root, "Empty").value.kind).toBe("null");
    expect(propertyOf(root, "Pointer").value.kind).toBe("nil");
  });
});

describe("Delphi form failure surface", () => {
  it("reports an unknown value type and stops instead of guessing a resync", () => {
    const root = rootOf(
      form(
        component("TForm1", "Form1", [
          property_("Good", int32(7)),
          property_("Future", bytes(24, 1, 2, 3)),
          property_("After", int32(9)),
        ]),
      ),
    );
    expect(root.class_name?.text).toBe("TForm1");
    expect(propertyOf(root, "Good").value).toMatchObject({
      kind: "integer",
      text: "7",
    });
    const last = root.properties.at(-1);
    expect(last?.value).toMatchObject({
      kind: "unknown",
      reason: "Unsupported value type unknown_value_type(24) (24).",
    });
    expect(root.unknown?.reason).toContain("Unsupported value type");
    // A sibling read after an unsupported type would be invented, not decoded.
    expect(root.properties.map(({ name }) => name.text)).not.toContain("After");
  });

  it("keeps the parsed name on a property whose value cannot be decoded", () => {
    const root = rootOf(
      form(
        component("TForm1", "Form1", [property_("Future", bytes(24, 1, 2, 3))]),
      ),
    );
    expect(root.properties[0]).toMatchObject({
      name: { text: "Future" },
      value_type: "unknown_value_type(24)",
    });
    expect(root.properties[0]?.value).toMatchObject({ kind: "unknown" });
  });

  it("stops every ancestor when a child property cannot be decoded", () => {
    // The unsupported type leaves its payload bytes in the stream. Reading them
    // as further components would invent siblings from unknown bytes.
    const root = rootOf(
      form(
        component("TForm1", "Form1", [], {
          children: [
            component("TButton", "Button1", [
              property_("Future", bytes(24, 1, 2, 3)),
            ]),
            component("TPanel", "Panel1"),
          ],
        }),
      ),
    );
    expect(root.children).toHaveLength(1);
    const [child] = root.children;
    expect(child?.class_name?.text).toBe("TButton");
    expect(child?.properties[0]).toMatchObject({ name: { text: "Future" } });
    expect(child?.unknown?.reason).toContain("Unsupported value type");
    expect(root.unknown?.reason).toContain("Unsupported value type");
    // Nothing after the stop is decoded, so no byte pattern becomes a component.
    expect(
      root.children.flatMap((item) => item.class_name?.text ?? []),
    ).not.toContain("TPanel");
  });

  it("bounds value nesting instead of exhausting the call stack", () => {
    let nested = int32(1);
    for (let level = 0; level < 64; level += 1) nested = list(nested);
    const root = rootOf(
      form(component("TForm1", "Form1", [property_("Deep", nested)])),
    );
    expect(root.unknown?.reason).toContain("nesting exceeds");
  });

  it("charges every retained item against the decode budget", () => {
    // An empty collection item costs two input bytes, so a small payload can
    // otherwise produce unbounded retained objects.
    const items = Array.from({ length: 40000 }, () => bytes(1, 0));
    const payload = form(
      component("TForm1", "Form1", [
        property_("Columns", collection(...items)),
      ]),
    );
    const root = rootOf(payload);
    expect(root.unknown?.reason).toContain("budget exhausted");
    const column = propertyOf(root, "Columns").value;
    expect(column.kind).toBe("unknown");
  });

  it("reports a truncated stream as an unknown on the object", () => {
    const payload = form(
      component("TForm1", "Form1", [property_("Height", int32(70000))]),
    );
    const root = rootOf(payload.subarray(0, payload.length - 4));
    expect(root.class_name?.text).toBe("TForm1");
    expect(root.unknown?.reason).toContain("Payload ended");
    expect(root.unknown?.bytes_hex.length).toBeGreaterThan(0);
  });

  it("does not throw when the payload ends mid value", () => {
    const payload = form(
      component("TForm1", "Form1", [property_("A", int32(1))]),
    );
    for (let length = 5; length < payload.length; length++)
      expect(() => decode(payload.subarray(0, length))).not.toThrow();
  });

  it("rejects a child position that is not an integer value type", () => {
    const root = rootOf(
      form(
        component("TForm1", "Form1", [], {
          children: [
            component("TButton", "Button1", [], {
              prefix: [0xf2, 6, 1, 0x41],
            }),
          ],
        }),
      ),
    );
    expect(root.children[0]?.unknown?.reason).toContain("vaInt8/16/32");
  });

  it("keeps the entries decoded before a list stops", () => {
    // A vaList whose second entry is truncated mid-value: the fixture's two
    // trailing terminators are cut so the payload genuinely ends inside the
    // second integer, and the first entry stays decoded evidence.
    const payload = form(
      component("TForm1", "Form1", [
        property_(
          "Items",
          Buffer.concat([bytes(1), int32(7), bytes(4, 0x11, 0x22)]),
        ),
      ]),
    );
    const root = rootOf(payload.subarray(0, payload.length - 2));
    expect(root.unknown?.reason).toBeDefined();
    const property = root.properties[0];
    expect(property?.name.text).toBe("Items");
    expect(property?.value).toMatchObject({ kind: "list" });
    if (property?.value.kind !== "list") throw new Error("Expected a list");
    expect(property.value.items).toMatchObject([{ kind: "integer" }]);
  });

  it("keeps a property name when the type marker itself is truncated", () => {
    const payload = form(
      component("TForm1", "Form1", [property_("Future", int32(7))]),
    );
    const marker = Buffer.from([0x06, ...Buffer.from("Future", "latin1")]);
    const at = payload.indexOf(marker);
    const truncated = payload.subarray(0, at + marker.length);
    const root = rootOf(truncated);
    expect(root.unknown?.reason).toBeDefined();
    expect(root.properties.at(-1)?.name.text).toBe("Future");
    expect(root.properties.at(-1)?.value_type).toBe("unknown");
  });

  it("reports bytes that follow the root component terminator", () => {
    const payload = form(component("TForm1", "Form1", []));
    const withSuffix = Buffer.concat([payload, bytes(0xde, 0xad, 0xbe, 0xef)]);
    const root = rootOf(withSuffix);
    expect(root.unknown?.reason).toContain(
      "bytes follow the root component terminator",
    );
    expect(root.unknown?.bytes_hex).toContain("deadbeef");
  });
});

describe("Delphi form partial collections", () => {
  it("keeps collection items when a nested list stops", () => {
    // A collection whose second item has a list-valued property that ends
    // mid-value: the item and its partial list must stay on the collection
    // property, and the earlier item must not disappear.
    const payload = form(
      component("TForm1", "Form1", [
        property_(
          "Columns",
          collection(
            collectionItem(int8(0), property_("Width", int32(64))),
            collectionItem(
              int8(1),
              property_(
                "Values",
                Buffer.concat([bytes(1), int32(7), bytes(4, 0x11, 0x22)]),
              ),
            ),
          ),
        ),
      ]),
    );
    const root = rootOf(payload.subarray(0, payload.length - 3));
    const property = root.properties[0];
    expect(property?.value_type).toBe("vaCollection");
    expect(property?.value.kind).toBe("collection");
    if (property?.value.kind !== "collection")
      throw new Error("Expected a collection");
    expect(property.value.items).toHaveLength(2);
    expect(property.value.items[0]?.properties[0]?.name.text).toBe("Width");
    const values = property.value.items[1]?.properties[0];
    expect(values?.name.text).toBe("Values");
    expect(values?.value.kind).toBe("list");
  });
});
