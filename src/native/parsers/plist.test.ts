import { expect, it } from "vitest";

import {
  parsePlistJson,
  parsePlistXml,
  plistJsonNeedsNumberTypes,
} from "./plist.js";

it("keeps exact decimal text for JSON integers that XML shows are integers", () => {
  const parsed = parsePlistJson(
    '{"Max":18446744073709551615,"Min":-9223372036854775808,"Near":9007199254740993,"Edge":9007199254740992,"Safe":9007199254740991,"Real":1e21,"Ratio":0.5}',
    [
      "<plist><dict>",
      "<key>Max</key><integer>18446744073709551615</integer>",
      "<key>Min</key><integer>-9223372036854775808</integer>",
      "<key>Near</key><integer>9007199254740993</integer>",
      "<key>Edge</key><integer>9007199254740992</integer>",
      "<key>Safe</key><integer>9007199254740991</integer>",
      "<key>Real</key><real>1e+21</real>",
      "<key>Ratio</key><real>0.5</real>",
      "</dict></plist>",
    ].join(""),
  );
  if (!parsed.ok) throw new Error("expected plist JSON to parse");
  // JSON keeps each literal's digits, so integers that round to the same
  // number stay distinct.
  expect(parsed.value.value).toEqual({
    Max: { $plist_type: "integer", decimal: "18446744073709551615" },
    Min: { $plist_type: "integer", decimal: "-9223372036854775808" },
    Near: { $plist_type: "integer", decimal: "9007199254740993" },
    Edge: { $plist_type: "integer", decimal: "9007199254740992" },
    Safe: 9007199254740991,
    Real: 1e21,
    Ratio: 0.5,
  });
  expect(parsed.value.limitations).toEqual([
    expect.stringContaining("4 integer value(s)"),
  ]);
});

it("keeps integral JSON reals beyond the safe range as reals", () => {
  const output = '{"Real":9007199254740992,"Large":100000000000000000000}';
  expect(plistJsonNeedsNumberTypes(output)).toBe(true);
  const parsed = parsePlistJson(
    output,
    "<plist><dict><key>Real</key><real>9007199254740992</real><key>Large</key><real>1e+20</real></dict></plist>",
  );
  if (!parsed.ok) throw new Error("expected plist JSON to parse");
  expect(parsed.value.value).toEqual({ Real: 9007199254740992, Large: 1e20 });
  expect(parsed.value.limitations).toEqual([]);
});

it.each([
  ["without element types", undefined],
  [
    "when an integer and a real decode alike",
    "<plist><array><integer>9007199254740992</integer><real>9007199254740992</real></array></plist>",
  ],
])("does not label an unsafe JSON number an integer %s", (_case, xml) => {
  const parsed = parsePlistJson("[9007199254740992,9007199254740992]", xml);
  if (!parsed.ok) throw new Error("expected plist JSON to parse");
  expect(parsed.value.value).toEqual([9007199254740992, 9007199254740992]);
  expect(parsed.value.limitations).toEqual([
    expect.stringContaining("2 number(s)"),
  ]);
});

it("requests element types only for unsafe integral JSON numbers", () => {
  expect(
    plistJsonNeedsNumberTypes(
      '{"Safe":9007199254740991,"Real":1e21,"Text":"9007199254740993"}',
    ),
  ).toBe(false);
  expect(plistJsonNeedsNumberTypes("{")).toBe(false);
});

it("reports no limitation when every JSON integer is exact", () => {
  const parsed = parsePlistJson('{"Count":42,"Nested":[-1,0]}');
  if (!parsed.ok) throw new Error("expected plist JSON to parse");
  expect(parsed.value.value).toEqual({ Count: 42, Nested: [-1, 0] });
  expect(parsed.value.limitations).toEqual([]);
});

it("recovers exact XML integers from their element literals", () => {
  const parsed = parsePlistXml(
    "<plist><dict><key>Max</key><integer>18446744073709551615</integer><key>Safe</key><integer>7</integer><key>Blob</key><data>AA==</data></dict></plist>",
  );
  if (!parsed.ok) throw new Error("expected plist XML to parse");
  expect(parsed.value.value).toEqual({
    Max: { $plist_type: "integer", decimal: "18446744073709551615" },
    Safe: 7,
    Blob: { $plist_type: "data", base64: "AA==" },
  });
  expect(parsed.value.limitations).toEqual([
    expect.stringContaining("XML conversion"),
    expect.stringContaining("1 integer value(s)"),
  ]);
});

it("keeps integral XML reals beyond the safe range as reals", () => {
  const parsed = parsePlistXml(
    "<plist><dict><key>Real</key><real>9007199254740992</real><key>Blob</key><data>AA==</data></dict></plist>",
  );
  if (!parsed.ok) throw new Error("expected plist XML to parse");
  expect(parsed.value.value).toEqual({
    Real: 9007199254740992,
    Blob: { $plist_type: "data", base64: "AA==" },
  });
  expect(parsed.value.limitations).toEqual([
    expect.stringContaining("XML conversion"),
  ]);
});

it("reports XML numbers whose integer or real origin is ambiguous", () => {
  const parsed = parsePlistXml(
    "<plist><array><integer>9007199254740993</integer><real>9007199254740992</real><data>AA==</data></array></plist>",
  );
  if (!parsed.ok) throw new Error("expected plist XML to parse");
  expect(parsed.value.value).toEqual([
    9007199254740992,
    9007199254740992,
    { $plist_type: "data", base64: "AA==" },
  ]);
  expect(parsed.value.limitations).toEqual([
    expect.stringContaining("XML conversion"),
    expect.stringContaining("2 number(s)"),
  ]);
});
