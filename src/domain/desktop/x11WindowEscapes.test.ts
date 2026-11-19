import { expect, it } from "vitest";
import { parseX11WindowProperties } from "./x11Windows.js";

const actualXprop =
  'WM_CLASS = "xterm", "ReaFill3Fixture"\n_NET_WM_NAME = "Line one\\nLine two\\tTabbed \\\\ literal \\"quote\\" café"\nWM_NAME = "FLAT-CONTROL"\n_NET_WM_PID = 149\n';

it("retains the exact UTF-8 title independently read from XGetWindowProperty", () => {
  expect(parseX11WindowProperties(actualXprop)).toMatchObject({
    instance: "xterm",
    class: "ReaFill3Fixture",
    pid: 149,
    title: 'Line one\nLine two\tTabbed \\ literal "quote" café',
  });
});

it("decodes octal UTF-8 title bytes separately from legacy property bytes", () => {
  const output = String.raw`WM_CLASS = "r\351a", "Notes"
_NET_WM_NAME = "Caf\303\251 \346\227\245\346\234\254\t\\303"
WM_NAME = "Caf\351 (legacy)"
`;
  expect(parseX11WindowProperties(output)).toMatchObject({
    instance: "réa",
    class: "Notes",
    title: "Café 日本\t\\303",
  });
});

it.each([
  [String.raw`"one\ntwo"`, "one\ntwo"],
  [String.raw`"one\ttwo"`, "one\ttwo"],
  [String.raw`"literal \\n \"quote\""`, 'literal \\n "quote"'],
  ['"plain caption"', "plain caption"],
  ['"one\u2028two\u2029three"', "one\u2028two\u2029three"],
])("decodes the producer's quoted title %s", (wire, title) => {
  expect(parseX11WindowProperties(`_NET_WM_NAME = ${wire}\n`).title).toBe(
    title,
  );
});

it.each([
  String.raw`"bad \303"`,
  '<Invalid UTF-8 string: Tail too short> "quoted prefix"',
])("uses the legacy title for malformed UTF-8 property %s", (wire) => {
  const legacy = String.raw`WM_NAME(STRING): bytes = "Caf\351"`;
  expect(
    parseX11WindowProperties(`_NET_WM_NAME = ${wire}\n${legacy}`).title,
  ).toBe("Café");
});

// Real xprop 1.2.8 writes different escaping in its default and 8s formats.
it.each([
  {
    type: "STRING",
    rendered: String.raw`"Caf\351 "quoted" C:\notes \123"`,
    bytes: String.raw`"Caf\351 \"quoted\" C:\\notes \\123"`,
    title: 'Café "quoted" C:\\notes \\123',
  },
  {
    type: "UTF8_STRING",
    rendered: String.raw`""quoted" 日本 \123"`,
    bytes: String.raw`"\"quoted\" \346\227\245\346\234\254 \\123"`,
    title: '"quoted" 日本 \\123',
  },
])(
  "reads an exact legacy title from the typed $type property",
  ({ type, rendered, bytes, title }) => {
    const output = `WM_NAME(${type}) = ${rendered}\nWM_NAME(${type}): bytes = ${bytes}\n`;
    expect(parseX11WindowProperties(output).title).toBe(title);
  },
);

it.each([
  ['"a "quoted" title"', 'a "quoted" title'],
  [String.raw`"literal \012 or line break"`, null],
])(
  "does not invent a title when the compound-text rendering %s is ambiguous",
  (rendered, title) => {
    expect(
      parseX11WindowProperties(`WM_NAME(COMPOUND_TEXT) = ${rendered}\n`).title,
    ).toBe(title);
  },
);

// Captured with native xprop; expected text was independently read through Xlib.
const nativeSamples = [
  {
    case: "newline",
    wire: '_NET_WM_NAME = "before \\n after"\n',
    expected: "before \n after",
  },
  {
    case: "tab",
    wire: '_NET_WM_NAME = "before \\t after"\n',
    expected: "before \t after",
  },
  {
    case: "return",
    wire: '_NET_WM_NAME = "before \\015 after"\n',
    expected: "before \r after",
  },
  {
    case: "backspace",
    wire: '_NET_WM_NAME = "before \\010 after"\n',
    expected: "before \b after",
  },
  {
    case: "formfeed",
    wire: '_NET_WM_NAME = "before \\014 after"\n',
    expected: "before \f after",
  },
  {
    case: "vertical-tab",
    wire: '_NET_WM_NAME = "before \\013 after"\n',
    expected: "before \u000b after",
  },
  {
    case: "bell",
    wire: '_NET_WM_NAME = "before \\007 after"\n',
    expected: "before \u0007 after",
  },
  {
    case: "escape",
    wire: '_NET_WM_NAME = "before \\033 after"\n',
    expected: "before \u001b after",
  },
  {
    case: "soh",
    wire: '_NET_WM_NAME = "before \\001 after"\n',
    expected: "before \u0001 after",
  },
  {
    case: "delete",
    wire: '_NET_WM_NAME = "before \\177 after"\n',
    expected: "before  after",
  },
  {
    case: "non-ascii",
    wire: '_NET_WM_NAME = "before café 日本 😀 after"\n',
    expected: "before café 日本 😀 after",
  },
  {
    case: "c1",
    wire: '_NET_WM_NAME = "before  after"\n',
    expected: "before  after",
  },
  {
    case: "literal-escapes",
    wire: '_NET_WM_NAME = "before \\\\n\\\\t\\\\001 after"\n',
    expected: "before \\n\\t\\001 after",
  },
  {
    case: "quotes",
    wire: '_NET_WM_NAME = "before \\" \\\\ after"\n',
    expected: 'before " \\ after',
  },
];

it.each(nativeSamples)(
  "retains native xprop $case text",
  ({ wire, expected }) => {
    expect(parseX11WindowProperties(wire).title).toBe(expected);
  },
);

it("keeps an unknown class member in position and falls back from an unknown title", () => {
  const output = String.raw`WM_CLASS = "unknown\q", "RealClass"
_NET_WM_NAME = "unknown\777"
WM_NAME(STRING): bytes = "fallback\ncaption"
_NET_WM_PID = 21
_NET_WM_WINDOW_TYPE = _NET_WM_WINDOW_TYPE_DIALOG
`;
  expect(parseX11WindowProperties(output)).toEqual({
    instance: null,
    class: "RealClass",
    title: "fallback\ncaption",
    pid: 21,
    window_type: "dialog",
  });
});
