import { describe, expect, it } from "vitest";

import { parseX11ClientList, parseX11WindowProperties } from "./x11Windows.js";

describe("parseX11ClientList", () => {
  it("reads window ids with and without the type annotation", () => {
    expect(
      parseX11ClientList("_NET_CLIENT_LIST: window id # 0x800003, 0xA00007\n"),
    ).toEqual(["0x800003", "0xa00007"]);
    expect(
      parseX11ClientList("_NET_CLIENT_LIST(WINDOW): window id # 0x800003\n"),
    ).toEqual(["0x800003"]);
  });

  it("returns no windows for an empty list and nothing when the window manager does not publish one", () => {
    expect(parseX11ClientList("_NET_CLIENT_LIST: window id # \n")).toEqual([]);
    expect(parseX11ClientList("_NET_CLIENT_LIST:  not found.\n")).toBe(
      undefined,
    );
    expect(parseX11ClientList("")).toBe(undefined);
  });
});

describe("parseX11WindowProperties", () => {
  it("reads the class pair, title, owner pid and window type", () => {
    expect(
      parseX11WindowProperties(
        [
          'WM_CLASS = "mousepad", "Mousepad"',
          '_NET_WM_NAME = "Untitled 1 - Mousepad"',
          "_NET_WM_PID = 29",
          'WM_NAME = "Untitled 1 - Mousepad"',
          "_NET_WM_WINDOW_TYPE = _NET_WM_WINDOW_TYPE_NORMAL",
        ].join("\n"),
      ),
    ).toEqual({
      instance: "mousepad",
      class: "Mousepad",
      title: "Untitled 1 - Mousepad",
      pid: 29,
      window_type: "normal",
    });
  });

  it("falls back to WM_NAME, unescapes quotes and tolerates missing properties", () => {
    expect(
      parseX11WindowProperties(
        [
          'WM_CLASS = "app"',
          "_NET_WM_NAME:  not found.",
          'WM_NAME = "a \\"quoted\\" title"',
          "_NET_WM_PID:  not found.",
          "_NET_WM_WINDOW_TYPE:  not found.",
        ].join("\n"),
      ),
    ).toEqual({
      instance: "app",
      class: null,
      title: 'a "quoted" title',
      pid: null,
      window_type: null,
    });
  });
});
