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

it.each([
  [String.raw`"one\ntwo"`, "one\ntwo"],
  [String.raw`"one\ttwo"`, "one\ttwo"],
  [String.raw`"literal \\n \"quote\""`, 'literal \\n "quote"'],
  ['"plain caption"', "plain caption"],
])("decodes the producer's quoted title %s", (wire, title) => {
  expect(parseX11WindowProperties(`_NET_WM_NAME = ${wire}\n`).title).toBe(
    title,
  );
});

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
WM_NAME = "fallback\ncaption"
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
