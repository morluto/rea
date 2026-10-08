import { expect, it } from "vitest";

import {
  parseXmlPropertyList,
  restorePrototypeKeys,
} from "./propertyListKeys.js";

const plist = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${body}</plist>`;

it.each([
  "<key>__proto__</key>",
  "<key><![CDATA[__proto__]]></key>",
  "<key>&#95;&#x5F;proto__</key>",
])("keeps a dictionary keyed %s as an ordinary own property", (key) => {
  const parsed = parseXmlPropertyList(
    plist(
      `<dict><key>CFBundleExecutable</key><string>App</string>${key}<dict><key>polluted</key><true/></dict><key>list</key><array><dict>${key}<string>x</string><key>kept</key><integer>1</integer></dict></array></dict>`,
    ),
  );
  expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  expect(parsed).toMatchObject({
    CFBundleExecutable: "App",
    list: [{ kept: 1 }],
  });
  const dictionary = parsed as Record<string, unknown>;
  expect(Object.hasOwn(dictionary, "__proto__")).toBe(true);
  expect(dictionary["__proto__"]).toEqual({ polluted: true });
  const nested = (dictionary.list as Record<string, unknown>[])[0] ?? {};
  expect(Object.hasOwn(nested, "__proto__")).toBe(true);
  expect(nested?.["__proto__"]).toBe("x");
  expect(JSON.stringify(parsed)).toContain('"__proto__":{"polluted":true}');
});

it("keeps __proto__ text in strings, comments, and similar keys", () => {
  const text = plist(
    "<dict><!-- <key>__proto__</key> --><key> __proto__ </key><string><![CDATA[<key>__proto__</key>]]></string><key>__rea_prototype_key__</key><string>__proto__</string></dict>",
  );
  expect(parseXmlPropertyList(text)).toEqual({
    " __proto__ ": "<key>__proto__</key>",
    __rea_prototype_key__: "__proto__",
  });
});

it("keeps an entity-encoded key that decodes to the placeholder", () => {
  const text = plist(
    "<dict><key>&#95;&#95;rea_prototype_key__</key><string>kept</string><key>__proto__</key><string>x</string></dict>",
  );
  const parsed = parseXmlPropertyList(text) as Record<string, unknown>;
  expect(parsed.__rea_prototype_key__).toBe("kept");
  expect(Object.hasOwn(parsed, "__proto__")).toBe(true);
  expect(parsed["__proto__"]).toBe("x");
});

it("keeps entity-like text beyond Unicode in comments and CDATA", () => {
  const text = plist(
    "<!-- &#99999999999; --><dict><key>raw</key><string><![CDATA[&#x110000;]]></string><key>__proto__</key><string>x</string></dict>",
  );
  const parsed = parseXmlPropertyList(text) as Record<string, unknown>;
  expect(parsed.raw).toBe("&#x110000;");
  expect(parsed["__proto__"]).toBe("x");
});

it("restores __proto__ entries that binary decoding lost to the setter", () => {
  // `plist`'s binary decoder assigns dict[key] = value, so an object-valued
  // __proto__ member replaces the dictionary's prototype and a null member
  // erases it. The decoded tree has no other source of non-standard
  // prototypes, so the prototype always names the lost value.
  const lost = { polluted: true };
  const outer: Record<string, unknown> = { kept: 1 };
  Object.setPrototypeOf(outer, lost);
  const nullKeyed: Record<string, unknown> = { nested: outer };
  Object.setPrototypeOf(nullKeyed, null);
  const tree = { a: [nullKeyed], plain: { b: 2 } };

  const restored = restorePrototypeKeys(tree) as Record<string, unknown>;
  expect(Object.getPrototypeOf(restored)).toBe(Object.prototype);
  expect(restored.plain).toEqual({ b: 2 });
  const inner = (restored.a as Record<string, unknown>[])[0];
  expect(Object.getPrototypeOf(inner)).toBe(Object.prototype);
  expect(inner?.["__proto__"]).toBe(null);
  const deep = inner?.nested as Record<string, unknown>;
  expect(Object.getPrototypeOf(deep)).toBe(Object.prototype);
  expect(deep["__proto__"]).toEqual({ polluted: true });
  expect(JSON.stringify(restored)).toBe(
    '{"a":[{"nested":{"kept":1,"__proto__":{"polluted":true}},"__proto__":null}],"plain":{"b":2}}',
  );
});
