import { expect, it } from "vitest";

import {
  omitPrototypeKeys,
  omittedPrototypeKeysLimitation,
  parseXmlPropertyList,
} from "./propertyListKeys.js";

const plist = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0">${body}</plist>`;

it.each([
  "<key>__proto__</key>",
  "<key><![CDATA[__proto__]]></key>",
  "<key>&#95;&#x5F;proto__</key>",
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
  expect(omittedPrototypeKeysLimitation(1)).toBe(
    "1 dictionary entry keyed __proto__ was omitted because REA results cannot represent that key.",
  );
});
