import { expect, it } from "vitest";

import { omitPrototypeKeys, parseXmlPropertyList } from "./propertyListKeys.js";

const plist = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${body}</plist>`;

it.each([
  "<key>__proto__</key>",
  "<key><![CDATA[__proto__]]></key>",
  "<key>&#95;&#x5F;proto__</key>",
  "<key >__proto__</key >",
  "<key\n>__proto__</key>",
  "<key>__proto__<!-- trailing comment --></key>",
  "<key><![CDATA[__proto__]]><!-- trailing comment --></key>",
])("omits and counts a dictionary keyed %s", (key) => {
  const parsed = parseXmlPropertyList(
    plist(
      `<dict><key>CFBundleExecutable</key><string>App</string>${key}<dict><key>polluted</key><true/></dict><key>list</key><array><dict>${key}<string>x</string><key>kept</key><integer>1</integer></dict></array></dict>`,
    ),
  );
  expect(parsed).toEqual({
    value: { CFBundleExecutable: "App", list: [{ kept: 1 }] },
    omittedPrototypeKeys: 2,
  });
  expect(Object.getPrototypeOf(parsed.value)).toBe(Object.prototype);
});

it("keeps __proto__ text in strings, comments, and similar keys", () => {
  const text = plist(
    "<dict><!-- <key>__proto__</key> --><key> __proto__ </key><string><![CDATA[<key>__proto__</key>]]></string><key>__rea_prototype_key__</key><string>__proto__</string></dict>",
  );
  expect(parseXmlPropertyList(text)).toEqual({
    value: {
      " __proto__ ": "<key>__proto__</key>",
      __rea_prototype_key__: "__proto__",
    },
    omittedPrototypeKeys: 0,
  });
});

it("keeps an entity-encoded key that decodes to the placeholder", () => {
  const text = plist(
    "<dict><key>&#95;&#95;rea_prototype_key__</key><string>kept</string><key>__proto__</key><string>x</string></dict>",
  );
  expect(parseXmlPropertyList(text)).toEqual({
    value: { __rea_prototype_key__: "kept" },
    omittedPrototypeKeys: 1,
  });
});

it("keeps entity-like text beyond Unicode in comments and CDATA", () => {
  const text = plist(
    "<!-- &#99999999999; --><dict><key>raw</key><string><![CDATA[&#x110000;]]></string><key>__proto__</key><string>x</string></dict>",
  );
  expect(parseXmlPropertyList(text)).toEqual({
    value: { raw: "&#x110000;" },
    omittedPrototypeKeys: 1,
  });
});

it("omits own __proto__ entries that JSON decoding creates", () => {
  const decoded: unknown = JSON.parse(
    '{"__proto__":{"x":1},"a":[{"__proto__":2,"b":3}]}',
  );
  expect(omitPrototypeKeys(decoded)).toEqual({
    value: { a: [{ b: 3 }] },
    omittedPrototypeKeys: 2,
  });
});

it("preserves the pinned decoder's first-child key semantics", () => {
  const text = plist(
    "<dict><key>__pro<![CDATA[to__]]></key><string>kept</string><key>__proto__</key><string>omitted</string></dict>",
  );
  expect(parseXmlPropertyList(text)).toEqual({
    value: { __pro: "kept" },
    omittedPrototypeKeys: 1,
  });
});

it("preserves OpenStep dictionary and array autodetection", () => {
  expect(
    parseXmlPropertyList(
      "  { CFBundleExecutable = App; values = (one, two); __rea_prototype_key__ = kept; }",
    ),
  ).toEqual({
    value: {
      CFBundleExecutable: "App",
      values: ["one", "two"],
      __rea_prototype_key__: "kept",
    },
    omittedPrototypeKeys: 0,
  });
  expect(parseXmlPropertyList("(one, two)")).toEqual({
    value: ["one", "two"],
    omittedPrototypeKeys: 0,
  });
});

/** The single-member chain of a nested dictionary, down to its deepest value. */
const deepestValue = (value: unknown): unknown => {
  let cursor = value;
  while (
    cursor !== null &&
    typeof cursor === "object" &&
    !Array.isArray(cursor) &&
    "k" in cursor
  ) {
    cursor = (cursor as Record<string, unknown>).k;
  }
  return cursor;
};

/** The single-member chain of a nested array, down to its deepest value. */
const deepestEntry = (value: unknown): unknown => {
  let cursor = value;
  while (Array.isArray(cursor) && cursor.length === 1) cursor = cursor[0];
  return cursor;
};

const nestedDictionaries = (depth: number) =>
  plist(
    "<dict><key>k</key>".repeat(depth) +
      "<string>x</string>" +
      "</dict>".repeat(depth),
  );

const nestedArrays = (depth: number) =>
  plist(
    "<array>".repeat(depth) + "<string>x</string>" + "</array>".repeat(depth),
  );

it("rejects XML nesting beyond the projection limit with the limit diagnostic", () => {
  // `plist` and the prototype-key traversal recurse once per level, so the
  // depth check must report the same bounded-resource error as the projection
  // instead of letting those recursive passes exhaust the call stack.
  const limit = new RangeError("Plist exceeds 128 nesting levels");
  expect(() => parseXmlPropertyList(nestedDictionaries(129))).toThrow(limit);
  expect(() => parseXmlPropertyList(nestedArrays(129))).toThrow(limit);
  expect(() => parseXmlPropertyList(nestedDictionaries(3000))).toThrow(limit);
  expect(() => parseXmlPropertyList(nestedArrays(4000))).toThrow(limit);
});

it("decodes XML property lists exactly at the projection nesting limit", () => {
  expect(
    deepestValue(parseXmlPropertyList(nestedDictionaries(128)).value),
  ).toBe("x");
  expect(deepestEntry(parseXmlPropertyList(nestedArrays(128)).value)).toBe("x");
  expect(
    parseXmlPropertyList(
      plist("<array>".repeat(128) + "<array/>" + "</array>".repeat(128)),
    ).value,
  ).toBeDefined();
});

it("does not count markup inside comments, CDATA, or the doctype as nesting", () => {
  const text = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd" [<!ENTITY deep "<dict/>">]>
<plist version="1.0"><dict>
  <key>a</key><string><![CDATA[<dict><array><dict>]]></string>
  <!-- <dict><key>k</key> -->
  <key>b</key><array><!-- <array> --><string>x</string></array>
</dict></plist>`;
  expect(parseXmlPropertyList(text)).toEqual({
    value: { a: "<dict><array><dict>", b: ["x"] },
    omittedPrototypeKeys: 0,
  });
});

it.each(['"', "'"])(
  "counts containers with quoted XML delimiters using %s attributes",
  (quote) => {
    const opening = `<dict note=${quote}/>${quote}><key>k</key>`;
    const text = plist(
      opening.repeat(3000) + "<string>x</string>" + "</dict>".repeat(3000),
    );
    expect(() => parseXmlPropertyList(text)).toThrow(
      new RangeError("Plist exceeds 128 nesting levels"),
    );
    expect(
      parseXmlPropertyList(
        plist(
          "<array>" + `<dict note=${quote}>${quote}/>`.repeat(130) + "</array>",
        ),
      ).value,
    ).toEqual(Array.from({ length: 130 }, () => ({})));
  },
);

it("ignores complete DOCTYPE internal subsets when checking value depth", () => {
  const text = `<!DOCTYPE plist [
<!ENTITY first "unused">
<!-- <dict><array> -->
<!ENTITY second "${"<dict>".repeat(130)}">
]><plist><string>x</string></plist>`;
  expect(parseXmlPropertyList(text)).toEqual({
    value: "x",
    omittedPrototypeKeys: 0,
  });
});

it("bounds nested plist wrappers before recursive decoding", () => {
  const text =
    "<plist>".repeat(3000) + "<string>x</string>" + "</plist>".repeat(3000);
  expect(() => parseXmlPropertyList(text)).toThrow(
    new RangeError("Plist exceeds 128 nesting levels"),
  );
  expect(
    parseXmlPropertyList(plist("<plist><string>x</string></plist>")).value,
  ).toEqual(["x"]);
});

it.each(["\n", "\r\n", "\r", "\u0085", "\u2028", "\u2029"])(
  "preserves unrelated source values around %j line endings",
  (newline) => {
    const text = plist(
      `<dict>${newline}<key>kept&#13;key</key><string>a&#13;b&#x85;c&#x2028;d</string>${newline}<key${newline}>__proto__<!--tail--></key><string>omitted</string></dict>`,
    );
    expect(parseXmlPropertyList(text)).toEqual({
      value: { "kept\rkey": "a\rb\u0085c\u2028d" },
      omittedPrototypeKeys: 1,
    });
  },
);

it("locates sparse omitted keys across newline-dense source", () => {
  const lines = "\n".repeat(64 * 1024);
  const text = plist(
    `<dict>${lines}<key >__proto__</key><string>omitted</string><key>nested</key><dict>${lines}<key>__proto__<!--tail--></key><string>omitted</string><key>kept</key><true/></dict></dict>`,
  );
  expect(parseXmlPropertyList(text)).toEqual({
    value: { nested: { kept: true } },
    omittedPrototypeKeys: 2,
  });
});
